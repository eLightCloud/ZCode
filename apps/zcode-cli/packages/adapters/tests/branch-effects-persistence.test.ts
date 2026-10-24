import { createSqliteSessionStore } from "../src/storage/session-store.js";
import { checkpoint } from "../checks/sync-fixture.mjs";
import type { ProjectId, SessionId } from "@zcode/contracts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("preserves cross-branch effects through apply, cold restart and monotonic owner refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "branch-effects-persistence-"));
  const dbPath = join(root, "session.sqlite");
  let store = await createSqliteSessionStore({ dbPath });
  const target = { directory: root, projectID: "synthetic" as ProjectId };
  const original = checkpoint("effects-session"),
    session = original.session.id;
  const operation = randomUUID();
  const effect = {
    server: "synthetic",
    owner: "synthetic-owner",
    operation: "mail-1",
    requestKey: "key-1",
    receiptUri: "mcp-effect://mail-1",
    outcome: "unknown" as const,
  };
  try {
    await store.controlContinuation({ kind: "close", session, operation }, target);
    await store.controlContinuation(
      {
        kind: "stage",
        session,
        operation,
        management: { titleOverride: null, archived: false, deleted: false, pinned: false },
        dataBase64: Buffer.from(
          JSON.stringify({ ...original, version: 4, branchEffects: [effect] }),
        ).toString("base64"),
      },
      target,
    );
    await store.controlContinuation({ kind: "apply", session, operation }, target);
    await store.controlContinuation(
      { kind: "activate", session, operation, generation: 1, version: "chosen" },
      target,
    );
    await store.controlContinuation(
      { kind: "effects", session, operation, generation: 1, revision: 5, effects: [effect] },
      target,
    );
    await store.controlContinuation(
      { kind: "effects", session, operation, generation: 1, revision: 4, effects: [] },
      target,
    );
    await expect(
      store.controlContinuation(
        { kind: "effects", session, operation, generation: 1, revision: 5, effects: [] },
        target,
      ),
    ).rejects.toMatchObject({ code: "operation_conflict" });
    await expect(
      store.controlContinuation(
        { kind: "effects", session, operation, generation: 2, revision: 6, effects: [] },
        target,
      ),
    ).rejects.toMatchObject({ code: "admission_closed" });
    store.close();
    store = await createSqliteSessionStore({ dbPath });
    expect(
      (await store.exportTextCheckpoint({ sessionID: session as SessionId })).branchEffects,
    ).toEqual([effect]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
