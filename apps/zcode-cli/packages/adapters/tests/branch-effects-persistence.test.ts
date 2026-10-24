import { createSqliteSessionStore } from "../src/storage/session-store.js";
import { checkpoint } from "../checks/sync-fixture.mjs";
import type { ProjectId, SessionId, TextCheckpoint } from "@zcode/contracts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkpointEffectReferences, textCheckpointSchema } from "@zcode/contracts";

it("keeps an explicitly empty effect snapshot identical through offline apply and cold restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "empty-effects-continuation-"));
  const source = await createSqliteSessionStore({ dbPath: join(root, "source.sqlite") });
  const targetPath = join(root, "target.sqlite");
  let target = await createSqliteSessionStore({ dbPath: targetPath });
  const location = { directory: root, projectID: "synthetic" as ProjectId };
  const original = checkpoint("empty-effects-session");
  let current: TextCheckpoint = {
    ...original,
    version: 4,
    session: { ...original.session, lastOutcome: "completed" },
  };
  const session = current.session.id;
  try {
    for (const [store, branchMode] of [
      [source, "primary"],
      [target, "offline"],
    ] as const) {
      const operation = randomUUID();
      await store.controlContinuation({ kind: "close", session, operation }, location);
      await store.controlContinuation(
        {
          kind: "stage",
          session,
          operation,
          branchMode,
          management: { titleOverride: null, archived: false, deleted: false, pinned: false },
          dataBase64: Buffer.from(JSON.stringify(current)).toString("base64"),
        },
        location,
      );
      await store.controlContinuation({ kind: "apply", session, operation }, location);
      expect(
        JSON.parse(
          JSON.stringify(await store.exportTextCheckpoint({ sessionID: session as SessionId })),
        ),
      ).toEqual(current);
      await store.controlContinuation(
        branchMode === "offline"
          ? { kind: "activateOffline", session, operation, generation: 0, version: "chosen" }
          : { kind: "activate", session, operation, generation: 1, version: "chosen" },
        location,
      );
      if (branchMode === "primary") {
        await store.controlContinuation(
          { kind: "effects", session, operation, generation: 1, revision: 5, effects: [] },
          location,
        );
        current = JSON.parse(
          JSON.stringify(await store.exportTextCheckpoint({ sessionID: session as SessionId })),
        );
        expect(current.branchEffects).toEqual([]);
      }
    }
    target.close();
    target = await createSqliteSessionStore({ dbPath: targetPath });
    expect(
      JSON.parse(
        JSON.stringify(await target.exportTextCheckpoint({ sessionID: session as SessionId })),
      ),
    ).toEqual(current);
  } finally {
    source.close();
    target.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not invent an external effect for a rejected check, while preserving real execution uncertainty", () => {
  const original = checkpoint("not-started-session");
  const metadata = {
    schemaVersion: 1,
    mcpReadOnly: false,
    display: { kind: "mcp_tool", serverName: "synthetic", toolName: "send" },
  };
  const payload = (notStarted: boolean) =>
    textCheckpointSchema.parse({
      ...original,
      version: 4,
      messages: original.messages.map((message, index) =>
        index !== 1
          ? message
          : {
              ...message,
              parts: [
                ...message.parts,
                {
                  id: "rejected-part",
                  type: "tool",
                  callID: "rejected-call",
                  tool: "mcp__synthetic__send",
                  state: {
                    status: "error",
                    input: {},
                    error: "SYNTHETIC_REJECTED",
                    time: { start: 1, end: 2 },
                    metadata: {
                      ...metadata,
                      ...(notStarted ? { effectExecution: "not_started" } : {}),
                    },
                  },
                },
              ],
            },
      ),
    });
  expect(checkpointEffectReferences(payload(true))).toEqual([]);
  expect(checkpointEffectReferences(payload(false))).toMatchObject([
    { server: "synthetic", operation: "rejected-call", outcome: "unknown" },
  ]);
});

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
