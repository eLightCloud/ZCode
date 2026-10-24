import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { SessionResidentPool, type SessionResidencyFacts } from "../src/zcode-protocol/session-resident-pool.js";

const safe = (): SessionResidencyFacts => ({ persisted: true, hasResidencyBlockingWork: false,
  hasPendingInteractions: false, hasQueuedCommands: false, hasSubscribers: false,
  hasLegacySubscriber: false, lastActivityAt: 1 });

function fixture(facts: SessionResidencyFacts | null = safe(), close = async () => {}) {
  const ids = new Set(["one", "two"]);
  const deactivate = vi.fn((id: string) => { ids.delete(id); return close(); });
  const pool = new SessionResidentPool({ listSessionIds: () => [...ids],
    readResidencyFacts: () => facts, deactivate });
  return { pool, ids, deactivate };
}

it.each([
  null, { ...safe(), persisted: false }, { ...safe(), hasResidencyBlockingWork: true },
  { ...safe(), hasPendingInteractions: true }, { ...safe(), hasQueuedCommands: true },
  { ...safe(), hasSubscribers: true }, { ...safe(), hasLegacySubscriber: true },
])("does not retire busy, draft, subscribed or unknown native work", async facts => {
  const { pool, ids, deactivate } = fixture(facts);
  expect(await pool.maintenance({ action: "begin", operationId: randomUUID() }))
    .toMatchObject({ state: "blocked", reasonCode: "native_activity" });
  expect(deactivate).not.toHaveBeenCalled();
  expect(ids.size).toBe(2);
  const release = await pool.acquireOperation();
  release();
});

it("waits for admitted protocol operations before retirement", async () => {
  const { pool, deactivate } = fixture();
  const release = await pool.acquireOperation();
  const operationId = randomUUID();
  expect((await pool.maintenance({ action: "begin", operationId })).state).toBe("blocked");
  expect(deactivate).not.toHaveBeenCalled();
  release();
  expect(await pool.maintenance({ action: "begin", operationId })).toEqual({ operationId, state: "held" });
});

it("closes admission before asynchronous retirement and exact cancellation waits for cleanup", async () => {
  let finish!: () => void;
  const closing = new Promise<void>(resolve => { finish = resolve; });
  const { pool, ids } = fixture(safe(), () => closing);
  const operationId = randomUUID();
  const begin = pool.maintenance({ action: "begin", operationId });
  await Promise.resolve();
  expect(ids.size).toBe(0);
  await expect(pool.acquireOperation()).rejects.toThrow("maintenance");
  const cancelled = pool.maintenance({ action: "cancel", operationId });
  let released = false;
  void cancelled.then(() => { released = true; });
  await Promise.resolve();
  expect(released).toBe(false);
  finish();
  expect(await begin).toEqual({ state: "held", operationId });
  expect(await cancelled).toEqual({ state: "released", operationId: null });
  const release = await pool.acquireOperation();
  release();
});

it("another operation cannot release a held runtime", async () => {
  const { pool } = fixture();
  const operationId = randomUUID();
  await pool.maintenance({ action: "begin", operationId });
  expect(await pool.maintenance({ action: "cancel", operationId: randomUUID() }))
    .toEqual({ operationId, state: "blocked", reasonCode: "operation_conflict" });
  await expect(pool.acquireOperation()).rejects.toThrow("maintenance");
  expect(await pool.maintenance({ action: "status", operationId })).toEqual({ operationId, state: "held" });
});

it("failed app cleanup retains the guard and never claims release", async () => {
  const { pool } = fixture(safe(), async () => { throw new Error("synthetic cleanup failure"); });
  const operationId = randomUUID();
  expect(await pool.maintenance({ action: "begin", operationId }))
    .toMatchObject({ state: "blocked", reasonCode: "unconfirmed" });
  expect(await pool.maintenance({ action: "cancel", operationId }))
    .toMatchObject({ state: "blocked", reasonCode: "unconfirmed" });
  await expect(pool.acquireOperation()).rejects.toThrow("maintenance");
});
