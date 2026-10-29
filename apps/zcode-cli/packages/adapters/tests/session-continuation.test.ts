import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { textCheckpointSchema, type ProjectId, type SessionId } from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/session-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function checkpoint(text = "source reply") {
  return textCheckpointSchema.parse({
    format: "zcode.text-checkpoint",
    version: 1,
    session: {
      id: "session-continuation",
      slug: "test",
      title: "Synthetic",
      version: "1",
      time: { created: 1, updated: 2 },
    },
    modelSelection: { providerId: "synthetic", modelId: "test" },
    modelSelectionEntryId: "model-entry",
    inputs: [],
    messages: [
      {
        info: { id: "user", role: "user", agent: "build", time: { created: 1 } },
        parts: [{ id: "u-text", type: "text", text: "prompt" }],
      },
      {
        info: {
          id: "assistant",
          role: "assistant",
          agent: "build",
          mode: "build",
          parentID: "user",
          time: { created: 1, completed: 2 },
          finish: "stop",
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ id: "a-text", type: "text", text }],
      },
    ],
  });
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zcode-continuation-"));
  roots.push(root);
  const path = join(root, "session.sqlite"),
    store = await createSqliteSessionStore({ dbPath: path });
  const target = { directory: root, projectID: "synthetic" as ProjectId };
  return { root, path, store, target, session: checkpoint().session.id as SessionId };
}
it("persistent close serializes with admission; accepted input may settle; restart never reopens", async () => {
  const { path, store, target, session } = await setup();
  await store.importTextCheckpoint({ checkpoint: checkpoint(), target });
  const input = {
    id: "accepted-before-barrier",
    sessionID: session,
    kind: "prompt",
    delivery: "queue" as const,
    payload: { text: "before" },
  };
  await store.saveSessionInput(input);
  const operation = randomUUID();
  await store.controlContinuation({ kind: "close", session, operation }, target);
  await store.saveSessionInput({ ...input, payload: { text: "settled-original-id" } });
  await expect(store.saveSessionInput({ ...input, id: "after-close" })).rejects.toThrow(
    "admission_closed",
  );
  store.close();
  const reopened = await createSqliteSessionStore({ dbPath: path });
  await expect(reopened.saveSessionInput({ ...input, id: "after-restart" })).rejects.toThrow(
    "admission_closed",
  );
  await reopened.controlContinuation({ kind: "cancel", session, operation }, target);
  await reopened.saveSessionInput({ ...input, id: "after-cancel" });
  reopened.close();
});

it("first enrollment keeps the exact source bytes while a target restore still resets grants", async () => {
  const { path, store, target, session } = await setup();
  await store.importTextCheckpoint({ checkpoint: checkpoint(), target });
  await store.saveSessionEntry({
    id: "source-grant",
    sessionID: session,
    type: "runtime/permission_full_access",
    time: { created: 1, updated: 2 },
    data: { synthetic: true },
  });
  await store.saveSessionEntry({
    id: "execution",
    sessionID: session,
    type: "runtime/execution_state",
    time: { created: 1, updated: 2 },
    data: { mode: "yolo", planEnabled: false },
  });
  const before = {
    session: await store.getSession(session),
    messages: await store.messages({ sessionID: session }),
    entries: await store.sessionEntries({ sessionID: session }),
  };
  const portable = await store.exportTextCheckpoint({ sessionID: session }),
    operation = randomUUID();
  await store.controlContinuation({ kind: "close", session, operation }, target);
  await store.controlContinuation(
    {
      kind: "stage",
      session,
      operation,
      preserveSource: true,
      management: { titleOverride: null, archived: false, deleted: false, pinned: false },
      dataBase64: Buffer.from(JSON.stringify(portable)).toString("base64"),
    },
    target,
  );
  store.close();
  const reopened = await createSqliteSessionStore({ dbPath: path });
  try {
    await reopened.controlContinuation({ kind: "apply", session, operation }, target);
    await reopened.controlContinuation({ kind: "apply", session, operation }, target);
    expect({
      session: await reopened.getSession(session),
      messages: await reopened.messages({ sessionID: session }),
      entries: await reopened.sessionEntries({ sessionID: session }),
    }).toEqual(before);
    expect(
      (await reopened.sessionEntries({ sessionID: session, type: "runtime/execution_state" }))[0]
        ?.data,
    ).toEqual({ mode: "yolo", planEnabled: false });
    const other = await createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      await other.importTextCheckpoint({ checkpoint: portable, target });
      expect(
        await other.sessionEntries({ sessionID: session, type: "runtime/permission_full_access" }),
      ).toEqual([]);
      expect(
        (await other.sessionEntries({ sessionID: session, type: "runtime/execution_state" }))[0]
          ?.data,
      ).toEqual({ mode: "build", planEnabled: false });
    } finally {
      other.close();
    }
  } finally {
    reopened.close();
  }
});

it("refuses source preservation when staged history does not match the source", async () => {
  const { store, target, session } = await setup();
  try {
    await store.importTextCheckpoint({ checkpoint: checkpoint("original"), target });
    const operation = randomUUID();
    await store.controlContinuation({ kind: "close", session, operation }, target);
    await store.controlContinuation(
      {
        kind: "stage",
        session,
        operation,
        preserveSource: true,
        management: { titleOverride: null, archived: false, deleted: false, pinned: false },
        dataBase64: Buffer.from(JSON.stringify(checkpoint("other"))).toString("base64"),
      },
      target,
    );
    await expect(
      store.controlContinuation({ kind: "apply", session, operation }, target),
    ).rejects.toThrow("checkpoint_changed");
    expect((await store.exportTextCheckpoint({ sessionID: session })).messages[1]?.parts).toEqual(
      checkpoint("original").messages[1]?.parts,
    );
  } finally {
    store.close();
  }
});
it("whole-copy apply is fenced, atomic and exactly replayable; old operations cannot reopen a new barrier", async () => {
  const { path, store, target, session } = await setup();
  await store.importTextCheckpoint({ checkpoint: checkpoint("old target"), target });
  const operation = randomUUID();
  await store.controlContinuation({ kind: "close", session, operation }, target);
  const captured = await store.controlContinuation({ kind: "capture", session, operation }, target);
  expect(
    JSON.parse(Buffer.from(captured.dataBase64!, "base64").toString()).messages[1].parts[0].text,
  ).toBe("old target");
  const stage = {
    kind: "stage" as const,
    session,
    operation,
    management: { titleOverride: null, pinned: false, archived: false, deleted: false },
    dataBase64: Buffer.from(JSON.stringify(checkpoint())).toString("base64"),
  };
  await store.controlContinuation(stage, target);
  await expect(
    store.controlContinuation(
      {
        ...stage,
        management: { titleOverride: null, pinned: false, archived: false, deleted: false },
        dataBase64: captured.dataBase64!,
      },
      target,
    ),
  ).rejects.toThrow("operation_conflict");
  const applied = await store.controlContinuation({ kind: "apply", session, operation }, target);
  expect(applied.state).toBe("applied");
  expect(await store.exportTextCheckpoint({ sessionID: session })).toEqual(checkpoint());
  await expect(
    store.controlContinuation({ kind: "cancel", session, operation }, target),
  ).rejects.toThrow("forward_only");
  const activation = {
    kind: "activate" as const,
    session,
    operation,
    version: "chosen",
    generation: 1,
  };
  await store.controlContinuation(activation, target);
  store.close();
  const reopened = await createSqliteSessionStore({ dbPath: path });
  expect(await reopened.controlContinuation(activation, target)).toMatchObject({
    state: "active",
    generation: 1,
  });
  const next = randomUUID();
  await reopened.controlContinuation({ kind: "close", session, operation: next }, target);
  await reopened.controlContinuation({ kind: "close", session, operation }, target);
  await reopened.controlContinuation(activation, target);
  expect(
    await reopened.controlContinuation({ kind: "read", session, operation }, target),
  ).toMatchObject({ operation: next, state: "closing" });
  await expect(
    reopened.saveSessionInput({
      id: "stale-input",
      sessionID: session,
      kind: "prompt",
      delivery: "startNow",
      payload: { text: "blocked" },
    }),
  ).rejects.toThrow("admission_closed");
  reopened.close();
});
it("identity collisions or unsupported target roll back without clearing transcript or staged package", async () => {
  const { store, target, session } = await setup();
  await store.importTextCheckpoint({ checkpoint: checkpoint("preserved"), target });
  const operation = randomUUID();
  await store.controlContinuation({ kind: "close", session, operation }, target);
  await store.controlContinuation(
    {
      kind: "stage",
      session,
      operation,
      management: { titleOverride: null, pinned: false, archived: false, deleted: false },
      dataBase64: Buffer.from(JSON.stringify(checkpoint())).toString("base64"),
    },
    target,
  );
  await expect(
    store.controlContinuation(
      { kind: "apply", session, operation },
      { ...target, directory: join(target.directory, "other") },
    ),
  ).rejects.toThrow("ineligible");
  expect(
    (await store.exportTextCheckpoint({ sessionID: session })).messages[1].parts[0],
  ).toMatchObject({ text: "preserved" });
  expect(
    await store.controlContinuation({ kind: "read", session, operation }, target),
  ).toMatchObject({ state: "staged" });
  store.close();
});
