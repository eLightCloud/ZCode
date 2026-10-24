import { expect, it, vi } from "vitest";
import {
  SessionResidentPool,
  type SessionResidencyFacts,
} from "../src/zcode-protocol/session-resident-pool.js";
const safe: SessionResidencyFacts = {
  persisted: true,
  hasResidencyBlockingWork: false,
  hasPendingInteractions: false,
  hasQueuedCommands: false,
  hasSubscribers: true,
  hasLegacySubscriber: true,
  lastActivityAt: 0,
};
function fixture(facts: SessionResidencyFacts = safe) {
  const deactivate = vi.fn(async () => {});
  const pool = new SessionResidentPool({
    listSessionIds: () => ["one"],
    readResidencyFacts: () => facts,
    deactivate,
  });
  return { pool, deactivate };
}
it("captures with live readers, fences admission and maintenance, then releases without retirement", async () => {
  const { pool, deactivate } = fixture();
  await pool.withCheckpoint("one", async () => {
    await expect(pool.acquireOperation("one")).rejects.toThrow("checkpoint");
    expect(
      (
        await pool.maintenance({
          action: "begin",
          operationId: "11111111-1111-4111-8111-111111111111",
        })
      ).state,
    ).toBe("blocked");
    pool.rebalance();
  });
  expect(deactivate).not.toHaveBeenCalled();
  const release = await pool.acquireOperation("one");
  release();
});
it.each(["hasResidencyBlockingWork", "hasPendingInteractions", "hasQueuedCommands"] as const)(
  "blocks %s and existing operations instead of exporting uncertain state",
  async (key) => {
    const { pool } = fixture({ ...safe, [key]: true });
    await expect(pool.withCheckpoint("one", async () => "unsafe")).rejects.toThrow("busy");
  },
);
it("waits for no admitted operation and releases even when export rejects", async () => {
  const { pool } = fixture();
  const release = await pool.acquireOperation("one");
  await expect(pool.withCheckpoint("one", async () => "unsafe")).rejects.toThrow("busy");
  release();
  await expect(
    pool.withCheckpoint("one", async () => {
      throw new Error("synthetic export failure");
    }),
  ).rejects.toThrow("synthetic export failure");
  expect(await pool.withCheckpoint("one", async () => "saved")).toBe("saved");
});
