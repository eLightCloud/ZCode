import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ServiceCollection,
  IZCodeTaskService,
  IModelSelectionService,
  type ZCodeTaskTerminalOutcome,
} from "../src/index.js";
import { AutomationRepo, createAutomationDispatcher } from "../src/node.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  manual = false,
  providerId = "controlled",
  beforeAutomationInput?: Parameters<typeof createAutomationDispatcher>[0]["beforeAutomationInput"],
) {
  const directory = await mkdtemp(join(tmpdir(), "native-dispatcher-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repo = new AutomationRepo(join(directory, "tasks-index.sqlite"));
  cleanups.push(async () => repo.close());
  const selection = {
    providerId,
    modelId: "proof",
    options: { reasoningLevel: "medium" },
  };
  const automation = await repo.create(
    {
      title: "controlled",
      cronExpr: "0 9 * * *",
      prompt: "controlled private prompt",
      recurring: true,
      workspacePath: directory,
      modelSelection: selection,
    },
    { nextRunAt: Date.now() + 3600_000 },
  );
  const run = manual
    ? (await repo.runNow(automation.automationId, { now: Date.now() }))!.run
    : undefined;
  const runId = run?.runId ?? `${automation.automationId}:${Date.now()}`;
  if (!run)
    await repo.upsertRunClaimed({
      runId,
      automationId: automation.automationId,
      workspaceKey: directory,
      scheduledAt: Date.now(),
      trigger: "schedule",
    });
  const terminal = new Emitter<ZCodeTaskTerminalOutcome>();
  const service = {
    createTask: vi.fn(async () => ({ taskId: "native-session" })),
    resumeTask: vi.fn(async () => ({})),
    setAutomationSessionConfig: vi.fn(async () => []),
    sendPrompt: vi.fn(async () => {}),
    setTaskUnread: vi.fn(async () => ({})),
    onDynamicTaskTerminalOutcome: vi.fn(() => terminal.event),
  };
  const modelView = vi.fn(async () => ({
    effectiveSelection: selection,
    preferredSelection: selection,
  }));
  const services = new ServiceCollection()
    .register(IZCodeTaskService, service as unknown as IZCodeTaskService)
    .register(IModelSelectionService, {
      getView: modelView,
    } as unknown as IModelSelectionService);
  const report = vi.fn();
  const warnings = vi.fn();
  const dispatcher = createAutomationDispatcher({
    repo,
    resolveServices: () => services,
    clientMode: "web-remote-replayable",
    logWarn: warnings,
    onSessionCreated: report,
    beforeAutomationInput,
  });
  cleanups.push(() => dispatcher.dispose());
  const request = {
    automationId: automation.automationId,
    runId,
    prompt: automation.prompt,
    workspacePath: directory,
  };
  return {
    dispatcher,
    repo,
    service,
    report,
    modelView,
    terminal,
    request,
    automation,
    selection,
    warnings,
  };
}

describe("native shared automation dispatcher", () => {
  it("keeps distinct low-sensitivity diagnostics for outcome and unread writes", async () => {
    const f = await fixture();
    await f.dispatcher.dispatch(f.request);
    await vi.waitFor(async () =>
      expect((await f.repo.getRun(f.request.runId))?.outcome).toBe("running"),
    );
    const privateError = new Error("synthetic-private-write-response");
    vi.spyOn(f.repo, "markRunOutcome").mockRejectedValueOnce(privateError);
    f.service.setTaskUnread.mockRejectedValueOnce(privateError);
    f.terminal.fire({
      taskId: "native-session",
      inputId: f.request.runId,
      outcome: "succeeded",
    });
    await f.dispatcher.dispose();
    const diagnostics = f.warnings.mock.calls.map((call) => call[2]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "automation.outcome.write",
          runId: f.request.runId,
          automationId: f.automation.automationId,
          reason: "native_write_failed",
        }),
        expect.objectContaining({
          event: "automation.unread.write",
          runId: f.request.runId,
          automationId: f.automation.automationId,
          reason: "native_write_failed",
        }),
      ]),
    );
    expect(JSON.stringify(diagnostics)).not.toContain(privateError.message);
    expect(JSON.stringify(diagnostics)).not.toContain(f.request.workspacePath);
  });
  it.each([false, true])("reports new sessions only after admission; manual=%s", async (manual) => {
    const f = await fixture(manual);
    let accept!: () => void;
    f.service.sendPrompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const work = f.dispatcher.dispatch(f.request);
    await vi.waitFor(() => expect(f.service.sendPrompt).toHaveBeenCalledOnce());
    expect(f.report).not.toHaveBeenCalled();
    expect(f.service.onDynamicTaskTerminalOutcome).toHaveBeenCalledBefore(f.service.sendPrompt);
    accept();
    await work;
    expect(f.report).toHaveBeenCalledExactlyOnceWith({
      sessionId: "native-session",
      messageId: f.request.runId,
      workspaceIdentity: undefined,
    });
    expect(f.service.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: f.request.runId,
        clientMode: "web-remote-replayable",
        content: f.request.prompt,
        automationId: f.automation.automationId,
      }),
    );
  });

  it("resumes bound tasks, applies the saved model and never reports a new session", async () => {
    const f = await fixture();
    await f.dispatcher.dispatch({
      ...f.request,
      targetTaskId: "bound-session",
    });
    expect(f.service.createTask).not.toHaveBeenCalled();
    expect(f.service.resumeTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "bound-session" }),
    );
    expect(f.service.setAutomationSessionConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: f.selection,
        traceId: f.request.runId,
      }),
    );
    expect(f.report).not.toHaveBeenCalled();
  });

  it("does not report a new session on rejected admission", async () => {
    const f = await fixture();
    f.service.sendPrompt.mockRejectedValue(new Error("controlled rejection"));
    await expect(f.dispatcher.dispatch(f.request)).rejects.toThrow("controlled rejection");
    await f.dispatcher.dispose();
    expect(f.report).not.toHaveBeenCalled();
    expect((await f.repo.getRun(f.request.runId))?.outcome).toBe("failed");
  });

  it.each(["succeeded", "failed", "stopped"] as const)(
    "settles only the exact input terminal: %s",
    async (outcome) => {
      const f = await fixture(true);
      await f.dispatcher.dispatch(f.request);
      f.terminal.fire({
        taskId: "native-session",
        inputId: "unrelated",
        outcome: "succeeded",
      });
      expect(await f.repo.runNow(f.automation.automationId, { now: Date.now() })).toBeNull();
      f.terminal.fire({
        taskId: "native-session",
        inputId: f.request.runId,
        outcome,
      });
      await vi.waitFor(async () =>
        expect((await f.repo.getRun(f.request.runId))?.outcome).toBe(outcome),
      );
      await f.dispatcher.dispose();
      expect(await f.repo.runNow(f.automation.automationId, { now: Date.now() })).not.toBeNull();
      expect(f.service.setTaskUnread).toHaveBeenCalledOnce();
    },
  );

  it("does not reinterpret a frozen run after model configuration changes", async () => {
    const f = await fixture();
    await f.repo.fixRunModelSelection(f.request.runId, f.selection);
    f.modelView.mockRejectedValue(new Error("current model registry unavailable"));
    await f.dispatcher.dispatch(f.request);
    expect(f.modelView).not.toHaveBeenCalled();
    expect(f.service.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ thoughtLevel: "medium" }),
    );
  });

  it("rejects an unresolved model before session creation", async () => {
    const f = await fixture();
    f.modelView.mockResolvedValue({
      effectiveSelection: undefined,
      preferredSelection: undefined,
    } as never);
    await expect(f.dispatcher.dispatch(f.request)).rejects.toThrow("模型选择不可用");
    expect(f.service.createTask).not.toHaveBeenCalled();
    expect(f.service.sendPrompt).not.toHaveBeenCalled();
  });

  it("waits for admission and pending terminal writes during shared disposal", async () => {
    const f = await fixture(true);
    let accept!: () => void;
    f.service.sendPrompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const work = f.dispatcher.dispatch(f.request);
    await vi.waitFor(() => expect(f.service.sendPrompt).toHaveBeenCalledOnce());
    const disposal = f.dispatcher.dispose();
    expect(f.dispatcher.dispose()).toBe(disposal);
    let done = false;
    void disposal.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    f.terminal.fire({
      taskId: "native-session",
      inputId: f.request.runId,
      outcome: "succeeded",
    });
    accept();
    await work;
    await disposal;
    expect((await f.repo.getRun(f.request.runId))?.outcome).toBe("succeeded");
    await expect(f.dispatcher.dispatch(f.request)).rejects.toThrow("disposed");
  });
});

it("checks the exact input before any task or prompt is created", async () => {
  const admission = vi.fn(async () => {
    throw new Error("synthetic admission blocked");
  });
  const f = await fixture(false, "controlled", admission);
  await expect(f.dispatcher.dispatch(f.request)).rejects.toThrow("synthetic admission blocked");
  expect(admission).toHaveBeenCalledWith(
    expect.objectContaining({
      automationId: f.request.automationId,
      inputId: f.request.runId,
      prompt: f.request.prompt,
    }),
  );
  expect(f.service.createTask).not.toHaveBeenCalled();
  expect(f.service.sendPrompt).not.toHaveBeenCalled();
});

it.each([false, true])(
  "rejects an application model before native admission (fixed=%s)",
  async (fixed) => {
    vi.stubEnv("ZCODE_APPLICATION_MODEL_TOKEN", "synthetic-native-workload-token-only");
    vi.stubEnv("ZCODE_APPLICATION_MODEL_BASE_URL", "http://127.0.0.1:1/v1");
    const f = await fixture(false, "application:fixture");
    if (fixed) await f.repo.fixRunModelSelection(f.request.runId, f.selection);
    await expect(f.dispatcher.dispatch(f.request)).rejects.toThrow("Automation");
    expect(f.service.createTask).not.toHaveBeenCalled();
    expect(f.service.resumeTask).not.toHaveBeenCalled();
    expect(f.service.sendPrompt).not.toHaveBeenCalled();
  },
);

it("keeps personal-provider automation available in an application host", async () => {
  vi.stubEnv("ZCODE_APPLICATION_MODEL_TOKEN", "synthetic-native-workload-token-only");
  vi.stubEnv("ZCODE_APPLICATION_MODEL_BASE_URL", "http://127.0.0.1:1/v1");
  const f = await fixture();
  await f.dispatcher.dispatch(f.request);
  expect(f.service.createTask).toHaveBeenCalledOnce();
  expect(f.service.sendPrompt).toHaveBeenCalledOnce();
});

it("passes admitted context through native attachments without changing the fixed prompt", async () => {
  const attachments = [
    {
      kind: "file" as const,
      filename: "business.json",
      mimeType: "application/json",
      textContent: '{"fixed":true}',
      sizeBytes: 14,
    },
  ];
  const f = await fixture(false, "controlled", async () => attachments);
  await f.dispatcher.dispatch(f.request);
  expect(f.service.sendPrompt).toHaveBeenCalledWith(
    expect.objectContaining({
      content: f.request.prompt,
      attachments,
    }),
  );
});

it.each([false, true])(
  "admits application automation using an explicitly supported user transport (fixed=%s)",
  async (fixed) => {
    vi.stubEnv("ZCODE_APPLICATION_MODEL_TOKEN", "synthetic-user-instance-proof-only");
    vi.stubEnv("ZCODE_APPLICATION_MODEL_BASE_URL", "http://127.0.0.1:1/v1");
    vi.stubEnv("ZCODE_APPLICATION_MODEL_AUTOMATION", "user");
    const f = await fixture(false, "application:fixture");
    if (fixed) await f.repo.fixRunModelSelection(f.request.runId, f.selection);
    await f.dispatcher.dispatch(f.request);
    expect(f.service.createTask).toHaveBeenCalledOnce();
    expect(f.service.sendPrompt).toHaveBeenCalledOnce();
  },
);

it.each(["true", "service", " user", ""])(
  "rejects an unknown application automation capability %s",
  async (capability) => {
    vi.stubEnv("ZCODE_APPLICATION_MODEL_TOKEN", "synthetic-user-instance-proof-only");
    vi.stubEnv("ZCODE_APPLICATION_MODEL_BASE_URL", "http://127.0.0.1:1/v1");
    vi.stubEnv("ZCODE_APPLICATION_MODEL_AUTOMATION", capability);
    const f = await fixture(false, "application:fixture");
    await expect(f.dispatcher.dispatch(f.request)).rejects.toThrow("Automation");
    expect(f.service.sendPrompt).not.toHaveBeenCalled();
  },
);
