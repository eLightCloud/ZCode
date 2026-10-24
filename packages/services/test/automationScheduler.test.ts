import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutomationRepo,
  OffPeakTaskRepo,
  CLAIM_STALE_MS,
  startAutomationScheduler,
  type AutomationSchedulerHandle,
  type SchedulerToMainMessage,
} from "../src/node.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "native-scheduler-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "tasks-index.sqlite");
  const repo = new AutomationRepo(databasePath);
  await repo.ensureReady();
  cleanups.push(async () => repo.close());
  const messages: SchedulerToMainMessage[] = [];
  function start() {
    const handle = startAutomationScheduler({
      databasePath,
      postMessage: (message) => messages.push(message),
    });
    cleanups.push(() => handle.dispose());
    return handle;
  }
  return { databasePath, repo, messages, start };
}
function params(title = "controlled native scheduler") {
  return {
    title,
    cronExpr: "0 9 * * *",
    prompt: "controlled scheduler admission proof",
    workspacePath: "/controlled-workspace",
    recurring: true,
  };
}
function request(messages: SchedulerToMainMessage[]) {
  return messages.find((message) => message.type === "cron-dispatch-request") as
    | Extract<SchedulerToMainMessage, { type: "cron-dispatch-request" }>
    | undefined;
}

describe("native scheduler through its public node facade", () => {
  it("claims real persisted rules and settles admission without Electron", async () => {
    const f = await fixture();
    const created = await f.repo.create(
      {
        ...params(),
        projectId: "project-proof",
        hostId: "host-proof",
        additionalDirectories: ["/additional-proof"],
      },
      { nextRunAt: Date.now() - 1000 },
    );
    const scheduler = f.start();
    await scheduler.ready;
    await vi.waitFor(() => expect(request(f.messages)).toBeDefined());
    const dispatched = request(f.messages)!;
    expect(dispatched.automationId).toBe(created.automationId);
    expect(dispatched).toMatchObject({
      projectId: "project-proof",
      hostId: "host-proof",
      additionalDirectories: ["/additional-proof"],
    });
    scheduler.acceptMessage({
      type: "cron-dispatch-result",
      runId: dispatched.runId,
      ok: true,
      taskId: "controlled-task",
      sessionId: "controlled-session",
    });
    const disposal = scheduler.dispose();
    expect(scheduler.dispose()).toBe(disposal);
    await disposal;
    await vi.waitFor(async () => {
      expect((await f.repo.getRun(dispatched.runId))?.dispatchStatus).toBe("dispatched");
      expect((await f.repo.get(created.automationId))?.runCount).toBe(1);
    });
  });

  it("releases its live claim on shutdown and restores the same run after restart", async () => {
    const f = await fixture();
    const created = await f.repo.create(params(), { nextRunAt: Date.now() - 1000 });
    const first = f.start();
    await first.ready;
    await vi.waitFor(() => expect(request(f.messages)).toBeDefined());
    const original = request(f.messages)!;
    await first.dispose();
    const released = await f.repo.claimDue(Date.now());
    expect(released.map((value) => value.automationId)).toEqual([created.automationId]);
    await f.repo.releaseClaim(created.automationId);
    f.messages.length = 0;
    const second = f.start();
    await second.ready;
    await vi.waitFor(() => expect(request(f.messages)?.runId).toBe(original.runId));
  });

  it("recovers a stale manual claim and permanent dispatch failure leaves cron unchanged", async () => {
    const f = await fixture();
    const next = Date.now() + 3600_000;
    const created = await f.repo.create(params(), { nextRunAt: next });
    const manual = await f.repo.runNow(created.automationId, {
      now: Date.now() - CLAIM_STALE_MS - 1000,
    });
    expect(manual).not.toBeNull();
    const scheduler = f.start();
    await scheduler.ready;
    await vi.waitFor(() => expect(request(f.messages)).toBeDefined());
    scheduler.acceptMessage({
      type: "cron-dispatch-result",
      runId: request(f.messages)!.runId,
      ok: false,
      failureKind: "permanent",
      error: "controlled missing capability",
    });
    await vi.waitFor(async () => {
      expect((await f.repo.getRun(manual!.run.runId))?.dispatchStatus).toBe("failed_to_dispatch");
      expect((await f.repo.get(created.automationId))?.nextRunAt).toBe(next);
    });
    expect(await f.repo.runNow(created.automationId, { now: Date.now() })).not.toBeNull();
  });

  it("a legacy off-peak record retains its explicit repair state and is never dispatched", async () => {
    const f = await fixture();
    const offPeak = new OffPeakTaskRepo(f.databasePath);
    cleanups.push(async () => offPeak.close());
    const scheduler: AutomationSchedulerHandle = f.start();
    await scheduler.ready;
    await vi.waitFor(() =>
      expect(f.messages.some((message) => message.type === "offpeak-active-count")).toBe(true),
    );
    const task = await offPeak.create(
      {
        title: "controlled legacy record",
        prompt: "proof",
        permissionMode: "guarded",
        modelSelection: { providerId: "controlled", modelId: "proof" },
        workspacePath: "/controlled-workspace",
      },
      { schedulable: true },
    );
    const db = new DatabaseSync(f.databasePath);
    try {
      db.prepare("UPDATE off_peak_tasks SET model_selection=NULL WHERE off_peak_task_id=?").run(
        task.offPeakTaskId,
      );
    } finally {
      db.close();
    }
    scheduler.acceptMessage({ type: "scheduler-wake", automationId: "controlled-wake" });
    await scheduler.dispose();
    const blocked = await offPeak.get(task.offPeakTaskId);
    expect(blocked?.status).toBe("queued");
    expect(blocked?.modelSelectionIssue?.code).toBe("repair-required");
    expect(f.messages.some((message) => message.type === "offpeak-dispatch-request")).toBe(false);
  });
});
