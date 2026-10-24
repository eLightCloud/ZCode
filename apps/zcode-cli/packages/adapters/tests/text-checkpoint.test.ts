import {
  textCheckpointSchema,
  type LogContext,
  type Logger,
  type ProjectId,
  type SessionId,
} from "@zcode/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../src/storage/session-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function example() {
  const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
  return textCheckpointSchema.parse({
    format: "zcode.text-checkpoint",
    version: 1,
    session: {
      id: "session-portable",
      slug: "portable",
      title: "Synthetic text",
      version: "1",
      time: { created: 1, updated: 2 },
    },
    modelSelection: { providerId: "test", modelId: "test-model" },
    modelSelectionEntryId: "selection-entry",
    messages: [
      {
        info: {
          id: "user-1",
          role: "user",
          agent: "build",
          time: { created: 1 },
          anchor: { sourceCommandId: "command-1" },
        },
        parts: [{ id: "part-user", type: "text", text: "synthetic prompt" }],
      },
      {
        info: {
          id: "assistant-1",
          role: "assistant",
          parentID: "user-1",
          agent: "build",
          mode: "build",
          time: { created: 1, completed: 2 },
          finish: "stop",
          cost: 0,
          tokens,
        },
        parts: [{ id: "part-assistant", type: "text", text: "synthetic reply" }],
      },
    ],
    inputs: [
      {
        id: "command-1",
        kind: "prompt",
        delivery: "startNow",
        payload: { text: "synthetic prompt" },
        admittedSequence: 0,
        promotedSequence: 0,
        promotedMessageID: "user-1",
        status: "promoted",
        time: { created: 1, updated: 2 },
      },
    ],
  });
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zcode-checkpoint-"));
  roots.push(root);
  const dbPath = join(root, "db.sqlite");
  const store = await createSqliteSessionStore({ dbPath });
  return { root, dbPath, store, target: { projectID: "target" as ProjectId, directory: root } };
}
describe("native text checkpoint contract", () => {
  it("correlates failures without logging rejected payloads or private paths", async () => {
    const { root, store: initialStore } = await setup();
    initialStore.close();
    const events: LogContext[] = [];
    const capture = (base: LogContext = {}): Logger => ({
      info: (_message, context) => {
        events.push({ ...base, ...context });
      },
      warn: (_message, context) => {
        events.push({ ...base, ...context });
      },
      debug() {},
      error() {},
      child: (context) => capture({ ...base, ...context }),
    });
    const store = await createSqliteSessionStore({
      dbPath: join(root, "observed.sqlite"),
      logger: capture(),
    });
    try {
      await expect(
        store.importTextCheckpoint({
          checkpoint: { secret: "S0_PRIVATE_MARKER" },
          target: { directory: root, projectID: "test" as ProjectId },
        }),
      ).rejects.toMatchObject({ code: "invalid_checkpoint" });
      expect(events).toHaveLength(2);
      expect(events[0]?.operationId).toBeTruthy();
      expect(events[1]).toMatchObject({
        operationId: events[0]?.operationId,
        status: "failed",
        code: "invalid_checkpoint",
      });
      expect(JSON.stringify(events)).not.toContain("S0_PRIVATE_MARKER");
      expect(JSON.stringify(events)).not.toContain(root);
    } finally {
      store.close();
    }
  });
  it("keeps identity, input terminal facts and order; rebinds paths and rejects overwrite", async () => {
    const { store, target } = await setup();
    const checkpoint = example();
    try {
      await store.importTextCheckpoint({ checkpoint, target });
      expect(
        await store.exportTextCheckpoint({ sessionID: checkpoint.session.id as SessionId }),
      ).toEqual(checkpoint);
      expect(await store.getSession(checkpoint.session.id as SessionId)).toMatchObject({
        directory: target.directory,
        time: checkpoint.session.time,
      });
      await expect(store.importTextCheckpoint({ checkpoint, target })).rejects.toMatchObject({
        code: "identity_conflict",
      });
      expect(
        await store.listSessionInputs({ sessionID: checkpoint.session.id as SessionId }),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  it.each(["version", "secret", "missing-reference", "duplicate-part", "pending", "tool"])(
    "rejects %s before any write",
    async (fault) => {
      const { store, target } = await setup();
      const checkpoint: any = example();
      if (fault === "version") checkpoint.version = 99;
      if (fault === "secret") checkpoint.session.permission = { token: "synthetic-secret" };
      if (fault === "missing-reference") checkpoint.messages[1].info.parentID = "absent";
      if (fault === "duplicate-part") checkpoint.messages[1].parts[0].id = "part-user";
      if (fault === "pending") checkpoint.inputs[0].status = "admitted";
      if (fault === "tool") checkpoint.messages[1].parts[0] = { id: "tool", type: "tool" };
      try {
        await expect(store.importTextCheckpoint({ checkpoint, target })).rejects.toMatchObject({
          code: "invalid_checkpoint",
        });
        expect(await store.listSessions()).toHaveLength(0);
      } finally {
        store.close();
      }
    },
  );
  it("rejects cross-session global message IDs without rebinding them", async () => {
    const { store, target } = await setup();
    const checkpoint = example();
    try {
      await store.createSession({
        id: "other" as SessionId,
        projectID: target.projectID,
        directory: target.directory,
        slug: "other",
        title: "other",
        version: "1",
      });
      await store.saveMessage({
        id: "user-1" as never,
        sessionID: "other" as SessionId,
        role: "user",
        agent: "build",
        time: { created: 1 },
      });
      await expect(store.importTextCheckpoint({ checkpoint, target })).rejects.toMatchObject({
        code: "identity_conflict",
      });
      expect(await store.getSession(checkpoint.session.id as SessionId)).toBeNull();
      expect(await store.messages({ sessionID: "other" as SessionId })).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  it("rolls back session and messages when a part write fails mid-transaction", async () => {
    const { store, dbPath, target } = await setup();
    const db = new DatabaseSync(dbPath);
    db.exec(
      "create trigger fail_part before insert on part begin select raise(abort, 'synthetic failure'); end",
    );
    try {
      await expect(
        store.importTextCheckpoint({ checkpoint: example(), target }),
      ).rejects.toMatchObject({ code: "storage_failure" });
      expect(await store.listSessions()).toHaveLength(0);
      expect(db.prepare("select count(*) as n from message").get()?.n).toBe(0);
      db.exec("drop trigger fail_part");
      await store.importTextCheckpoint({ checkpoint: example(), target });
    } finally {
      db.close();
      store.close();
    }
  });
  it.each(["entry", "input", "part", "metadata-array"])(
    "export blocks unsupported durable %s state",
    async (fault) => {
      const { store, target } = await setup();
      const sessionID = example().session.id as SessionId;
      try {
        await store.importTextCheckpoint({ checkpoint: example(), target });
        if (fault === "entry")
          await store.saveSessionEntry({
            id: "unknown-entry",
            sessionID,
            type: "future/required-state",
            time: { created: 2, updated: 2 },
            data: {},
          });
        if (fault === "input")
          await store.saveSessionInput({
            id: "pending",
            sessionID,
            kind: "prompt",
            delivery: "queue",
            payload: { text: "queued" },
          });
        if (fault === "part")
          await store.savePart({
            id: "unsupported" as never,
            sessionID,
            messageID: "assistant-1" as never,
            type: "reasoning",
            text: "synthetic-private",
            time: { start: 1 },
          });
        if (fault === "metadata-array") {
          const messages = await store.messages({ sessionID });
          await store.saveMessage({ ...messages[0]!.info, metadata: [] as never });
        }
        await expect(store.exportTextCheckpoint({ sessionID })).rejects.toMatchObject({
          code: "unsupported_state",
        });
      } finally {
        store.close();
      }
    },
  );
});

it("rejects restored session identifiers that could escape the artifact namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "checkpoint-session-id-"));
  roots.push(root);
  const store = await createSqliteSessionStore({ dbPath: join(root, "target.sqlite") });
  try {
    for (const id of [".", "..", "../outside", "nested/session"]) {
      const value = example();
      await expect(
        store.importTextCheckpoint({
          checkpoint: { ...value, session: { ...value.session, id } },
          target: { directory: root, projectID: "synthetic" as ProjectId },
        }),
      ).rejects.toMatchObject({ code: "invalid_checkpoint" });
      expect(await store.getSession(id as SessionId)).toBeNull();
    }
  } finally {
    store.close();
  }
});
