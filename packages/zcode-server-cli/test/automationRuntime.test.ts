import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRemoteWorkspaceIdentity, buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import {
  ServiceCollection,
  IZCodeTaskService,
  IModelSelectionService,
  type ZCodeTaskTerminalOutcome,
} from "@zcode/services";
import { AutomationRepo, OffPeakTaskRepo } from "@zcode/services/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServerAutomationRuntime } from "../src/server-core/automationRuntime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "native-server-automation-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "tasks-index.sqlite");
  const repo = new AutomationRepo(databasePath);
  cleanups.push(async () => repo.close());
  const terminal = new Emitter<ZCodeTaskTerminalOutcome>();
  const selection = {
    providerId: "controlled",
    modelId: "proof",
    options: { reasoningLevel: "medium" },
  };
  const task = {
    createTask: vi.fn(async () => ({ taskId: "controlled-native-session" })),
    sendPrompt: vi.fn(async () => {}),
    setTaskUnread: vi.fn(async () => ({})),
    onDynamicTaskTerminalOutcome: () => terminal.event,
  };
  const services = new ServiceCollection()
    .register(IZCodeTaskService, task as unknown as IZCodeTaskService)
    .register(IModelSelectionService, {
      getView: async () => ({ effectiveSelection: selection }),
    } as unknown as IModelSelectionService);
  const create = (nextRunAt: number, workspaceIdentity?: string) =>
    repo.create(
      {
        title: "controlled",
        cronExpr: "0 9 * * *",
        prompt: "saved synthetic input",
        modelSelection: selection,
        recurring: true,
        workspacePath: directory,
        workspaceIdentity,
      },
      { nextRunAt },
    );
  const start = () => {
    const runtime = startServerAutomationRuntime(services, {
      databasePath,
      serverId: "owned-server",
    });
    cleanups.push(() => runtime.dispose());
    return runtime;
  };
  return { repo, databasePath, directory, task, create, start, terminal, services };
}

describe("Server Core native automation wiring", () => {
  it("retries the same persisted run successfully after a temporary admission failure", async () => {
    const f = await fixture();
    f.task.sendPrompt.mockRejectedValueOnce(new Error("controlled temporary connection failure"));
    const rule = await f.create(Date.now() - 1000);
    const first = f.start();
    await first.ready;
    await vi.waitFor(async () =>
      expect((await f.repo.get(rule.automationId))?.retryAt).toBeGreaterThan(Date.now()),
    );
    await first.dispose();
    const failed = (await f.repo.listRuns(rule.automationId))[0]!;
    expect((await f.repo.get(rule.automationId))?.enabled).toBe(true);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue((await f.repo.get(rule.automationId))!.retryAt! + 1);
    try {
      const retry = f.start();
      await retry.ready;
      await vi.waitFor(async () =>
        expect((await f.repo.getRun(failed.runId))?.dispatchStatus).toBe("dispatched"),
      );
      await retry.dispose();
      expect(f.task.sendPrompt).toHaveBeenCalledTimes(2);
      expect((await f.repo.listRuns(rule.automationId)).map((run) => run.runId)).toEqual([
        failed.runId,
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("a confirmed missing model disables scheduled rules but failed manual admission preserves cron", async () => {
    const f = await fixture();
    const model = f.services.getOptional(IModelSelectionService)!;
    vi.spyOn(model, "getView").mockResolvedValue({ effectiveSelection: null } as never);
    const scheduled = await f.create(Date.now() - 1000);
    const nextRunAt = Date.now() + 3600_000;
    const manual = await f.create(nextRunAt);
    const runtime = f.start();
    await runtime.ready;
    await vi.waitFor(async () =>
      expect((await f.repo.get(scheduled.automationId))?.enabled).toBe(false),
    );
    expect((await f.repo.listRuns(scheduled.automationId))[0]?.error).toBe(
      "model_selection_unavailable",
    );
    const claim = (await f.repo.runNow(manual.automationId, { now: Date.now() }))!;
    await expect(runtime.runManual(claim)).rejects.toThrow("Native automation dispatch failed");
    await runtime.dispose();
    expect((await f.repo.get(manual.automationId))?.enabled).toBe(true);
    expect((await f.repo.get(manual.automationId))?.nextRunAt).toBe(nextRunAt);
    expect(await f.repo.runNow(manual.automationId, { now: Date.now() })).not.toBeNull();
    expect(f.task.createTask).not.toHaveBeenCalled();
  });

  it("server warnings preserve the writer event and run identity without private exception text", async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rule = await f.create(Date.now() - 1000);
      const runtime = f.start();
      await runtime.ready;
      await vi.waitFor(async () =>
        expect((await f.repo.listRuns(rule.automationId))[0]?.outcome).toBe("running"),
      );
      const run = (await f.repo.listRuns(rule.automationId))[0]!;
      f.task.setTaskUnread.mockRejectedValueOnce(new Error("synthetic-private-response"));
      f.terminal.fire({
        taskId: "controlled-native-session",
        inputId: run.runId,
        outcome: "succeeded",
      });
      await runtime.dispose();
      expect(warn.mock.calls.flat()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "automation.unread.write",
            runId: run.runId,
            automationId: rule.automationId,
            reason: "native_write_failed",
          }),
        ]),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-private-response");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(f.directory);
    } finally {
      warn.mockRestore();
    }
  });
  it("keeps native retry for dispatch failures and excludes private exception text from logs", async () => {
    const f = await fixture();
    const privateMarker = "synthetic-private-error-body";
    f.task.sendPrompt.mockRejectedValue(new Error(privateMarker));
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rule = await f.create(Date.now() - 1000);
      const runtime = f.start();
      await runtime.ready;
      await vi.waitFor(async () => {
        const current = await f.repo.get(rule.automationId);
        expect(current?.retryAt).toBeGreaterThan(Date.now());
        expect(current?.lifecycleStatus).toBe("active");
      });
      await runtime.dispose();
      expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain(privateMarker);
      expect((await f.repo.listRuns(rule.automationId))[0]?.error).toBe("native_dispatch_failed");
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("drains an already-started admission before releasing claims on shutdown", async () => {
    const f = await fixture();
    let accept!: () => void;
    f.task.sendPrompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const rule = await f.create(Date.now() - 1000);
    const runtime = f.start();
    await runtime.ready;
    await vi.waitFor(() => expect(f.task.sendPrompt).toHaveBeenCalledOnce());
    const disposal = runtime.dispose();
    expect(runtime.dispose()).toBe(disposal);
    let done = false;
    void disposal.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    accept();
    await disposal;
    expect((await f.repo.listRuns(rule.automationId))[0]?.dispatchStatus).toBe("dispatched");
    expect((await f.repo.get(rule.automationId))?.runCount).toBe(1);
  });

  it("settles persisted scheduled admission and exact-input terminal without Desktop", async () => {
    const f = await fixture();
    const rule = await f.create(Date.now() - 1000);
    const runtime = f.start();
    await runtime.ready;
    await vi.waitFor(() => expect(f.task.sendPrompt).toHaveBeenCalledOnce());
    const input = f.task.sendPrompt.mock.calls[0] as unknown as [
      { traceId: string; content: string },
    ];
    await vi.waitFor(async () =>
      expect((await f.repo.listRuns(rule.automationId))[0]?.dispatchStatus).toBe("dispatched"),
    );
    expect(input[0].content).toBe("saved synthetic input");
    f.terminal.fire({
      taskId: "controlled-native-session",
      inputId: input[0].traceId,
      outcome: "succeeded",
    });
    await runtime.dispose();
    expect((await f.repo.listRuns(rule.automationId))[0]?.outcome).toBe("succeeded");
    const restarted = f.start();
    await restarted.ready;
    await restarted.dispose();
    expect(f.task.sendPrompt).toHaveBeenCalledOnce();
  });

  it("manual admission preserves cron and holds its claim until the actual terminal", async () => {
    const f = await fixture();
    const nextRunAt = Date.now() + 3600_000;
    const rule = await f.create(nextRunAt);
    const runtime = f.start();
    await runtime.ready;
    const claimed = (await f.repo.runNow(rule.automationId, { now: Date.now() }))!;
    await runtime.runManual(claimed);
    await vi.waitFor(async () =>
      expect((await f.repo.getRun(claimed.run.runId))?.dispatchStatus).toBe("dispatched"),
    );
    expect((await f.repo.get(rule.automationId))?.nextRunAt).toBe(nextRunAt);
    expect(await f.repo.runNow(rule.automationId, { now: Date.now() })).toBeNull();
    f.terminal.fire({
      taskId: "controlled-native-session",
      inputId: claimed.run.runId,
      outcome: "stopped",
    });
    await runtime.dispose();
    expect((await f.repo.getRun(claimed.run.runId))?.outcome).toBe("stopped");
    expect(await f.repo.runNow(rule.automationId, { now: Date.now() })).not.toBeNull();
  });

  it("rejects remote Host identities before creating or admitting a local session", async () => {
    const f = await fixture();
    const rule = await f.create(
      Date.now() - 1000,
      buildRemoteWorkspaceIdentity("/workspace", {
        kind: "ssh",
        host: "other-host",
        username: "test",
      }),
    );
    const runtime = f.start();
    await runtime.ready;
    await vi.waitFor(async () =>
      expect((await f.repo.listRuns(rule.automationId))[0]?.dispatchStatus).toBe(
        "failed_to_dispatch",
      ),
    );
    expect(f.task.createTask).not.toHaveBeenCalled();
    expect(f.task.sendPrompt).not.toHaveBeenCalled();
    expect((await f.repo.listRuns(rule.automationId))[0]?.error).toBe("target_host_unavailable");
  });

  it("accepts the exact current server identity while refusing other server targets", async () => {
    const f = await fixture();
    const identity = buildServerRemoteWorkspaceIdentity({
      serverId: "owned-server",
      workspacePath: "/workspace",
    });
    // Use the actual rule path in the canonical identity, never reconstruct it by hand.
    await f.create(
      Date.now() - 1000,
      buildServerRemoteWorkspaceIdentity({
        serverId: "owned-server",
        workspacePath: f.directory,
      }),
    );
    const other = await f.create(
      Date.now() - 1000,
      identity.replace("owned-server", "other-server"),
    );
    const runtime = f.start();
    await runtime.ready;
    await vi.waitFor(() => expect(f.task.sendPrompt).toHaveBeenCalledOnce());
    await vi.waitFor(async () =>
      expect((await f.repo.listRuns(other.automationId))[0]?.dispatchStatus).toBe(
        "failed_to_dispatch",
      ),
    );
  });

  it("leaves off-peak records untouched on a host without an off-peak dispatcher", async () => {
    const f = await fixture();
    const offPeak = new OffPeakTaskRepo(f.databasePath);
    cleanups.push(async () => offPeak.close());
    const task = await offPeak.create(
      {
        title: "controlled",
        prompt: "proof",
        permissionMode: "guarded",
        modelSelection: {
          providerId: "controlled",
          modelId: "proof",
          options: { reasoningLevel: "medium" },
        },
        workspacePath: "/controlled",
      },
      { schedulable: true },
    );
    const before = await offPeak.get(task.offPeakTaskId);
    const runtime = f.start();
    await runtime.ready;
    await runtime.dispose();
    expect(await offPeak.get(task.offPeakTaskId)).toEqual(before);
    expect(f.task.sendPrompt).not.toHaveBeenCalled();
  });
});
