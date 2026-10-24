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
import { randomUUID } from "node:crypto";
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
  it("replacing v4 with a legacy checkpoint clears outcomes absent from the chosen body", async () => {
    const { store, target, dbPath } = await setup();
    const legacy = example();
    const session = legacy.session.id;
    const current = textCheckpointSchema.parse({
      ...legacy,
      version: 4,
      session: {
        ...legacy.session,
        lastOutcome: "completed",
        lastOutcomeInputId: "command-1",
        lastOutcomeAt: 2,
      },
    });
    try {
      await store.importTextCheckpoint({ checkpoint: current, target });
      expect(await store.exportTextCheckpoint({ sessionID: session })).toEqual(current);
      const operation = randomUUID();
      await store.controlContinuation({ kind: "close", session, operation }, target);
      await store.controlContinuation(
        {
          kind: "stage",
          session,
          operation,
          branchMode: "primary",
          management: { titleOverride: null, archived: false, deleted: false, pinned: false },
          dataBase64: Buffer.from(JSON.stringify(legacy)).toString("base64"),
        },
        target,
      );
      await store.controlContinuation({ kind: "apply", session, operation }, target);
      expect(await store.getSession(session)).toMatchObject({
        lastOutcome: undefined,
        lastOutcomeInputId: undefined,
        lastOutcomeAt: undefined,
      });
      expect(await store.exportTextCheckpoint({ sessionID: session })).toEqual(legacy);
      await store.controlContinuation(
        { kind: "activate", session, operation, generation: 1, version: "legacy-selected" },
        target,
      );
    } finally {
      store.close();
    }
    const reopened = await createSqliteSessionStore({ dbPath });
    try {
      expect(await reopened.exportTextCheckpoint({ sessionID: session })).toEqual(legacy);
    } finally {
      reopened.close();
    }
  });

  it("round-trips settled tool history, plan configuration and todos without replaying inputs", async () => {
    const { store, target } = await setup();
    const cp: any = example();
    cp.version = 4;
    cp.execution = {
      id: "execution",
      time: { created: 1, updated: 2 },
      data: { mode: "build", planEnabled: true },
    };
    cp.todos = [
      {
        content: "Synthetic pending work",
        status: "pending",
        priority: "high",
        position: 0,
        created: 1,
        updated: 2,
      },
    ];
    cp.messages[1].parts.unshift({
      id: "tool-1",
      type: "tool",
      callID: "call-1",
      tool: "web_search",
      state: {
        status: "completed",
        input: { query: "synthetic" },
        output: "SYNTHETIC_RESULT",
        title: "Search",
        metadata: { schemaVersion: 1, modelContent: "SYNTHETIC_RESULT" },
        time: { start: 1, end: 2 },
      },
    });
    try {
      await store.importTextCheckpoint({ checkpoint: cp, target });
      expect(await store.exportTextCheckpoint({ sessionID: cp.session.id })).toEqual(cp);
      expect(await store.readTodos({ sessionID: cp.session.id })).toMatchObject([
        { content: "Synthetic pending work", status: "pending" },
      ]);
      const pending = structuredClone(cp);
      pending.messages[1].parts[0].state.status = "running";
      expect(textCheckpointSchema.safeParse(pending).success).toBe(false);
    } finally {
      store.close();
    }
  });
  it("does not upload private reasoning while preserving the public provider history", async () => {
    const { store, target } = await setup();
    const cp = example();
    try {
      await store.importTextCheckpoint({ checkpoint: cp, target });
      await store.savePart({
        id: "private" as never,
        sessionID: cp.session.id as SessionId,
        messageID: "assistant-1" as never,
        type: "reasoning",
        text: "PRIVATE_REASONING_MARKER",
        time: { start: 1, end: 2 },
      });
      const saved = await store.exportTextCheckpoint({ sessionID: cp.session.id as SessionId });
      expect(JSON.stringify(saved)).not.toContain("PRIVATE_REASONING_MARKER");
      expect(saved.messages).toEqual(cp.messages);
    } finally {
      store.close();
    }
  });
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
            type: "tool",
            tool: "synthetic",
            callID: "pending-call",
            state: { status: "running", input: {}, time: { start: 1 } },
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

it.each(["error", "interrupted"] as const)(
  "preserves an actual %s terminal input without inventing an assistant",
  async (outcome) => {
    const { store, target } = await setup();
    const cp: any = example();
    cp.version = 4;
    cp.messages = cp.messages.slice(0, 1);
    cp.session.lastOutcome = outcome;
    cp.session.lastOutcomeInputId = "command-1";
    cp.session.lastOutcomeAt = 2;
    try {
      await store.importTextCheckpoint({ checkpoint: cp, target });
      expect(await store.exportTextCheckpoint({ sessionID: cp.session.id })).toEqual(cp);
      const stale = structuredClone(cp);
      stale.session.lastOutcomeInputId = "older-command";
      expect(textCheckpointSchema.safeParse(stale).success).toBe(false);
      delete stale.session.lastOutcomeInputId;
      expect(textCheckpointSchema.safeParse(stale).success).toBe(false);
    } finally {
      store.close();
    }
  },
);

it("cold-restores fork lineage and a conversation-only rewind without requiring the parent's database", async () => {
  const { store, target } = await setup();
  const cp: any = example();
  cp.version = 4;
  cp.session.parentID = "informational-parent";
  cp.session.taskType = "fork";
  cp.session.revert = {
    kind: "conversation_rewind",
    scope: "conversation",
    messageID: "assistant-1",
    targetMessageID: "user-1",
    keptMessageIDs: ["user-1", "assistant-1"],
    branchGeneration: 1,
  };
  cp.messages[0].info.metadata = {
    forkOrigin: { sessionId: "informational-parent", messageId: "old-parent-user" },
  };
  try {
    await store.importTextCheckpoint({ checkpoint: cp, target });
    expect(await store.exportTextCheckpoint({ sessionID: cp.session.id })).toEqual(cp);
  } finally {
    store.close();
  }
});

it("keeps the native compact boundary and synthetic summary as public provider context", async () => {
  const { store, target } = await setup();
  const cp: any = example();
  cp.version = 4;
  cp.messages[0].parts.push({
    id: "compact-part",
    type: "compaction",
    auto: false,
    trigger: "manual",
    compactBoundary: {
      boundaryId: "boundary",
      trigger: "manual",
      preCompactTokenCount: 100,
      summarizedMessageCount: 2,
      lastSummarizedMessageId: "assistant-1",
      summaryMessageIds: ["summary"],
      traceId: "synthetic-trace",
    },
  });
  cp.messages.push({
    info: {
      id: "summary",
      role: "user",
      agent: "build",
      time: { created: 2 },
      synthetic: true,
      summary: { diffs: [] },
      semantics: {
        origin: "agent_runtime",
        kind: "compact_summary",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
    },
    parts: [
      { id: "summary-part", type: "text", text: "SYNTHETIC_COMPACT_CONTEXT", synthetic: true },
    ],
  });
  try {
    await store.importTextCheckpoint({ checkpoint: cp, target });
    expect(await store.exportTextCheckpoint({ sessionID: cp.session.id })).toEqual(cp);
  } finally {
    store.close();
  }
});

it("restores registered tool media and serialization references, refusing source-only paths", async () => {
  const { store, target } = await setup();
  const cp: any = example();
  cp.version = 4;
  const uri = "zcode-artifact://session-portable/tool-result-00000000-0000-4000-8000-000000000001";
  cp.messages[1].parts.push({
    id: "media-tool",
    type: "tool",
    callID: "media-call",
    tool: "mcp__synthetic__image",
    state: {
      status: "completed",
      input: {},
      output: "SYNTHETIC_TOOL_MEDIA",
      title: "Media",
      time: { start: 1, end: 2 },
      metadata: {
        schemaVersion: 1,
        modelContent: "Synthetic text",
        modelContentLayout: [
          { type: "text", text: "Synthetic text" },
          { type: "attachment", attachmentIndex: 0 },
        ],
        serialization: {
          truncated: true,
          originalBytes: 100,
          returnedBytes: 10,
          budgetStrategy: "artifact",
          artifactPath: uri,
          artifactUri: uri,
        },
      },
      attachments: [
        {
          id: "embedded-image",
          type: "file",
          url: uri,
          mime: "image/png",
          metadata: { storageKind: "artifact", artifactUri: uri, recoverability: "provider_ready" },
        },
      ],
    },
  });
  try {
    await store.importTextCheckpoint({ checkpoint: cp, target });
    expect(await store.exportTextCheckpoint({ sessionID: cp.session.id })).toEqual(cp);
    const wrong = structuredClone(cp);
    wrong.messages[1].parts[1].state.metadata.serialization.artifactPath =
      "/source-only/private-artifact";
    expect(textCheckpointSchema.safeParse(wrong).success).toBe(false);
  } finally {
    store.close();
  }
});

it("lets unregistered old connections read but refuses every mutation of portable conversation facts", async () => {
  const { store, dbPath, target } = await setup();
  const cp = example();
  try {
    await store.importTextCheckpoint({ checkpoint: cp, target });
  } finally {
    store.close();
  }
  const old = new DatabaseSync(dbPath);
  try {
    expect(old.prepare("select count(*) as n from message").get()?.n).toBe(2);
    for (const table of ["session", "message", "part", "session_input", "session_entry", "todo"]) {
      for (const sql of [
        `delete from ${table}`,
        `update ${table} set ${table === "session" || table === "message" || table === "part" || table === "session_input" || table === "session_entry" ? "id=id" : "content=content"}`,
      ])
        expect(() => old.exec(sql)).toThrow(/zcode_portable_context_version/);
    }
    expect(old.prepare("select count(*) as n from message").get()?.n).toBe(2);
  } finally {
    old.close();
  }
  const reopened = await createSqliteSessionStore({ dbPath });
  try {
    expect(await reopened.exportTextCheckpoint({ sessionID: cp.session.id as SessionId })).toEqual(
      cp,
    );
  } finally {
    reopened.close();
  }
});
