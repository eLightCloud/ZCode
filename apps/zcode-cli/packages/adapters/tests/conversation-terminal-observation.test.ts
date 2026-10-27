import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createConversationSyncOutbox, createConversationSyncWorker } from "@zcode/adapters/conversation-sync";
import { ConversationSyncError, type ConversationSyncStore } from "@zcode/contracts";
import { digest } from "../src/conversation-sync/canonical.js";
import { initialState } from "../src/conversation-sync/transitions.js";
import { logger } from "../checks/sync-fixture.mjs";

const ready = { phase: "caught_up" as const, error: null, consecutiveFailures: 0, nextAttemptAt: null, localReasons: [] };
const scope = () => ({ tenant: randomUUID(), subject: randomUUID() });
const request = (session: string, id: string, parent: string | null = null) => ({
  session, operation: randomUUID(), command: { kind: "receive" as const, version: { id, parent, location: "synthetic", generation: 0, checkpoint: null } },
});
const receipt = (input: ReturnType<typeof request>) => ({ session: input.session, operation: input.operation,
  fingerprint: digest(input.command), outcome: "saved" as const, state: initialState() });

it("preserves exact pending operations and real attempts over reopen, then records one confirmed recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "terminal-observation-")), path = join(root, "sync.sqlite"), who = scope();
  let box = createConversationSyncOutbox(path);
  const first = request("one", "v1"), second = request("one", "v2", "v1");
  try {
    box.observation.start(who);
    box.stage(who, first); box.stage(who, second);
    box.observation.attempt(who, first.session, first.operation);
    box.observation.failed(who, first.session, first.operation, "subject_capacity");
    const before = box.observation.record(who, { ...ready, phase: "waiting_retry", error: "limit", consecutiveFailures: 1, nextAttemptAt: new Date(Date.now() + 1000).toISOString() });
    expect(before.queue.items).toBe(2); expect(before.queue.attempts).toBe(1);
    expect(before.reasons).toEqual([{ reason: "subject_capacity", sessions: 1, items: 2 }]);
    expect(before.queue.oldestPendingAt).not.toBeNull();
    expect(JSON.stringify(before)).not.toContain(first.operation);
    expect(JSON.stringify(before)).not.toContain(who.subject);
    box.close(); box = createConversationSyncOutbox(path);
    box.observation.start(who);
    expect(box.pending(who)).toEqual([first, second]);
    const reopened = box.observation.record(who, { ...ready, phase: "scanning" });
    expect(reopened.sequence).toBeGreaterThan(before.sequence);
    expect(reopened.queue.attempts).toBe(1);
    box.acknowledge(who, receipt(first)); box.acknowledge(who, receipt(first)); box.acknowledge(who, receipt(second));
    const after = box.observation.record(who, ready);
    expect(after.queue.items).toBe(0); expect(after.queue.acknowledgedItems).toBe(2);
    expect(after.queue.lastAcknowledgedAt).not.toBeNull();
    expect(after.recovery).toMatchObject({ lastRecoveredItems: 2, lastPendingPeak: 2, pendingPeak: 0 });
    expect(box.observation.record(who, ready).recovery).toEqual(after.recovery);
    const newer = box.observation.record(who, ready);
    expect(() => box.observation.rebase(who, before.sequence, 100)).toThrow("stale");
    box.observation.rebase(who, newer.sequence, 100);
    expect(box.observation.record(who, ready).sequence).toBe(101);
    expect(() => box.observation.record(scope(), ready)).toThrow("stale");
  } finally { box.close(); await rm(root, { recursive: true, force: true }); }
});

it("upgrades a real v6 outbox without fabricating creation or ACK times", async () => {
  const root = await mkdtemp(join(tmpdir(), "terminal-observation-v6-")), path = join(root, "sync.sqlite"), who = scope();
  let box = createConversationSyncOutbox(path);
  const first = request("legacy", "v1"); box.stage(who, first); const location = box.location(); box.close();
  const old = new DatabaseSync(path);
  old.exec(`drop table sync_reporting; alter table sync_outbox drop column created_ms;
    alter table sync_outbox drop column attempts; alter table sync_outbox drop column attempt_ms;
    alter table sync_outbox drop column failure; alter table sync_outbox drop column acknowledged_ms; pragma user_version=6;`);
  old.close(); box = createConversationSyncOutbox(path);
  try {
    box.observation.start(who); const seen = box.observation.record(who, { ...ready, phase: "scanning" });
    expect(box.location()).toBe(location); expect(box.pending(who)).toEqual([first]);
    expect(seen.queue).toMatchObject({ unknownAgeItems: 1, oldestPendingAt: null, lastAcknowledgedAt: null, attempts: 0 });
    expect(seen.phase).toBe("syncing");
  } finally { box.close(); await rm(root, { recursive: true, force: true }); }
});

it("keeps per-session causal blockers and retries original operations after the real limit is repaired", async () => {
  const box = createConversationSyncOutbox(":memory:"), who = scope();
  const inputs = [request("limited", "v1"), request("limited", "v2", "v1"), request("other", "v3")];
  box.observation.start(who); inputs.forEach(value => box.stage(who, value));
  let limited = true;
  const calls: string[] = [];
  const worker = createConversationSyncWorker({ scope: who, currentScope: () => who, outbox: box, logger,
    source: { changes: async after => ({ cursor: after + 1, items: [] }) },
    center: { execute: async (_scope, value) => {
      calls.push(value.operation);
      if (value.session === "limited" && limited) throw new ConversationSyncError("limit", { diagnostic: "version_limit" });
      return receipt(value as ReturnType<typeof request>);
    }} as ConversationSyncStore,
  });
  try {
    await expect(worker.reconcile()).rejects.toMatchObject({ code: "limit" });
    expect(box.pending(who)).toEqual(inputs.slice(0, 2));
    expect(box.observation.record(who, { ...ready, phase: "blocked" }).reasons[0]?.reason).toBe("version_limit");
    limited = false; await worker.reconcile();
    expect(calls).toEqual([inputs[0]!.operation, inputs[2]!.operation, inputs[0]!.operation, inputs[1]!.operation]);
    expect(box.observation.record(who, ready)).toMatchObject({ queue: { items: 0 }, recovery: { lastRecoveredItems: 3, lastPendingPeak: 3 } });
  } finally { box.close(); }
});
