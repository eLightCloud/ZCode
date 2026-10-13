import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceCollection, IZCodeTaskService, IModelSelectionService,
  type ZCodeTaskTerminalOutcome } from "../src/index.js";
import { AutomationRepo, createAutomationDispatcher } from "../src/node.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(manual = false) {
  const directory = await mkdtemp(join(tmpdir(), "native-dispatcher-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repo = new AutomationRepo(join(directory, "tasks-index.sqlite"));
  cleanups.push(async () => repo.close());
  const selection = { providerId: "controlled", modelId: "proof", options: { reasoningLevel: "medium" } };
  const automation = await repo.create({ title: "controlled", cronExpr: "0 9 * * *",
    prompt: "controlled private prompt", recurring: true, workspacePath: directory,
    modelSelection: selection }, { nextRunAt: Date.now() + 3600_000 });
  const run = manual ? (await repo.runNow(automation.automationId, { now: Date.now() }))!.run : undefined;
  const runId = run?.runId ?? `${automation.automationId}:${Date.now()}`;
  if (!run) await repo.upsertRunClaimed({ runId, automationId: automation.automationId,
    workspaceKey: directory, scheduledAt: Date.now(), trigger: "schedule" });
  const terminal = new Emitter<ZCodeTaskTerminalOutcome>();
  const service = {
    createTask: vi.fn(async () => ({ taskId: "native-session" })),
    resumeTask: vi.fn(async () => ({})),
    setAutomationSessionConfig: vi.fn(async () => []),
    sendPrompt: vi.fn(async () => {}),
    setTaskUnread: vi.fn(async () => ({})),
    onDynamicTaskTerminalOutcome: vi.fn(() => terminal.event),
  };
  const modelView = vi.fn(async () => ({ effectiveSelection: selection, preferredSelection: selection }));
  const services = new ServiceCollection()
    .register(IZCodeTaskService, service as unknown as IZCodeTaskService)
    .register(IModelSelectionService, { getView: modelView } as unknown as IModelSelectionService);
  const report = vi.fn();
  const warnings = vi.fn();
  const dispatcher = createAutomationDispatcher({ repo, resolveServices: () => services,
    clientMode: "web-remote-replayable", logWarn: warnings, onSessionCreated: report });
  cleanups.push(() => dispatcher.dispose());
  const request = { automationId: automation.automationId, runId,
    prompt: automation.prompt, workspacePath: directory };
  return { dispatcher, repo, service, report, modelView, terminal, request, automation, selection, warnings };
}

describe("native shared automation dispatcher", () => {
  it.each([false, true])("reports new sessions only after admission; manual=%s", async (manual) => {
    const f = await fixture(manual);
    let accept!: () => void;
    f.service.sendPrompt.mockImplementation(() => new Promise<void>(resolve => { accept = resolve; }));
    const work = f.dispatcher.dispatch(f.request);
    await vi.waitFor(() => expect(f.service.sendPrompt).toHaveBeenCalledOnce());
    expect(f.report).not.toHaveBeenCalled();
    expect(f.service.onDynamicTaskTerminalOutcome).toHaveBeenCalledBefore(f.service.sendPrompt);
    accept();
    await work;
    expect(f.report).toHaveBeenCalledExactlyOnceWith({ sessionId: "native-session",
      messageId: f.request.runId, workspaceIdentity: undefined });
    expect(f.service.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      traceId: f.request.runId, clientMode: "web-remote-replayable", content: f.request.prompt,
      automationId: f.automation.automationId }));
  });

  it("resumes bound tasks, applies the saved model and never reports a new session", async () => {
    const f = await fixture();
    await f.dispatcher.dispatch({ ...f.request, targetTaskId: "bound-session" });
    expect(f.service.createTask).not.toHaveBeenCalled();
    expect(f.service.resumeTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: "bound-session" }));
    expect(f.service.setAutomationSessionConfig).toHaveBeenCalledWith(expect.objectContaining({
      modelSelection: f.selection, traceId: f.request.runId }));
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

  it.each(["succeeded", "failed", "stopped"] as const)("settles only the exact input terminal: %s", async (outcome) => {
    const f = await fixture(true);
    await f.dispatcher.dispatch(f.request);
    f.terminal.fire({ taskId: "native-session", inputId: "unrelated", outcome: "succeeded" });
    expect(await f.repo.runNow(f.automation.automationId, { now: Date.now() })).toBeNull();
    f.terminal.fire({ taskId: "native-session", inputId: f.request.runId, outcome });
    await vi.waitFor(async () => expect((await f.repo.getRun(f.request.runId))?.outcome).toBe(outcome));
    await f.dispatcher.dispose();
    expect(await f.repo.runNow(f.automation.automationId, { now: Date.now() })).not.toBeNull();
    expect(f.service.setTaskUnread).toHaveBeenCalledOnce();
  });

  it("does not reinterpret a frozen run after model configuration changes", async () => {
    const f = await fixture();
    await f.repo.fixRunModelSelection(f.request.runId, f.selection);
    f.modelView.mockRejectedValue(new Error("current model registry unavailable"));
    await f.dispatcher.dispatch(f.request);
    expect(f.modelView).not.toHaveBeenCalled();
    expect(f.service.createTask).toHaveBeenCalledWith(expect.objectContaining({ thoughtLevel: "medium" }));
  });

  it("rejects an unresolved model before session creation", async () => {
    const f = await fixture();
    f.modelView.mockResolvedValue({ effectiveSelection: undefined, preferredSelection: undefined } as never);
    await expect(f.dispatcher.dispatch(f.request)).rejects.toThrow("模型选择不可用");
    expect(f.service.createTask).not.toHaveBeenCalled();
    expect(f.service.sendPrompt).not.toHaveBeenCalled();
  });

  it("waits for admission and pending terminal writes during shared disposal", async () => {
    const f = await fixture(true);
    let accept!: () => void;
    f.service.sendPrompt.mockImplementation(() => new Promise<void>(resolve => { accept = resolve; }));
    const work = f.dispatcher.dispatch(f.request);
    await vi.waitFor(() => expect(f.service.sendPrompt).toHaveBeenCalledOnce());
    const disposal = f.dispatcher.dispose();
    expect(f.dispatcher.dispose()).toBe(disposal);
    let done = false;
    void disposal.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    f.terminal.fire({ taskId: "native-session", inputId: f.request.runId, outcome: "succeeded" });
    accept();
    await work;
    await disposal;
    expect((await f.repo.getRun(f.request.runId))?.outcome).toBe("succeeded");
    await expect(f.dispatcher.dispatch(f.request)).rejects.toThrow("disposed");
  });
});
