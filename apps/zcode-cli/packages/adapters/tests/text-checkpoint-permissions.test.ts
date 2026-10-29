import { textCheckpointSchema, type SessionId } from "@zcode/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { checkpoint, events, logger } from "../checks/sync-fixture.mjs";
import { createSqliteSessionStore } from "../src/storage/session-store.js";

const roots: string[] = [];
afterEach(async () => {
  events.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["build", "guarded", "edit", "yolo", "auto"])(
  "syncs settled %s history without restoring source grants or local environment",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-permission-"));
    roots.push(root);
    const source = await createSqliteSessionStore({ dbPath: join(root, "source.sqlite"), logger });
    const targetPath = join(root, "target.sqlite");
    const target = await createSqliteSessionStore({ dbPath: targetPath });
    let targetClosed = false;
    const cp = checkpoint();
    const sessionID = cp.session.id as SessionId;
    try {
      await source.importTextCheckpoint({
        checkpoint: cp,
        target: { directory: root, projectID: "source" },
      });
      const messages = await source.messages({ sessionID });
      const user = messages[0]!;
      const intent = {
        sourceCommandId: "command",
        queueItemId: "queue_command",
        clientId: "client",
        kind: "sendText",
        text: "SYNTHETIC_PRIVATE_PROMPT",
        attachments: [],
        modelSelection: cp.modelSelection,
        mode: mode === "auto" ? "build" : mode,
        planEnabled: true,
        delivery: { requested: "startNow", admitted: "startNow" },
        order: { admissionSeq: 1 },
        steer: { state: "notRequested" },
        dispatch: { state: "drained" },
        admittedAt: 1,
      };
      await source.saveMessage({
        ...user.info,
        anchor: { sourceCommandId: "command" },
        metadata: { conversationInputIntent: intent },
      });
      await source.saveSessionInput({
        id: intent.queueItemId,
        sessionID,
        kind: "prompt",
        delivery: "startNow",
        payload: { text: intent.text, conversationInputIntent: intent },
      });
      await source.markSessionInputPromoted({
        id: intent.queueItemId,
        sessionID,
        promotedMessageID: user.info.id,
      });
      for (const type of [
        "runtime/bash_shell_selection",
        "runtime/permission_full_access",
        "runtime/workspace_checkpoint",
      ]) {
        await source.saveSessionEntry({
          id: type,
          sessionID,
          type,
          time: { created: 1, updated: 2 },
          data: { localOnly: "SYNTHETIC_PRIVATE_LOCAL_STATE" },
        });
      }
      await source.saveSessionEntry({
        id: "execution",
        sessionID,
        type: "runtime/execution_state",
        time: { created: 1, updated: 2 },
        data: { mode, planEnabled: true },
      });
      await source.savePart({
        id: "tool-read",
        sessionID,
        messageID: messages[1]!.info.id,
        type: "tool",
        tool: "read_file",
        callID: "read-call",
        metadata: {},
        state: {
          status: "completed",
          input: { file: "synthetic.txt" },
          output: "public result",
          title: "Read",
          metadata: {
            schemaVersion: 1,
            readFileState: { content: "SYNTHETIC_PRIVATE_LOCAL_STATE", path: "/source-only" },
          },
          time: { start: 1, end: 2 },
        },
      });
      const before = {
        session: await source.getSession(sessionID),
        messages: await source.messages({ sessionID }),
        entries: await source.sessionEntries({ sessionID }),
        inputs: await source.listSessionInputs({ sessionID }),
      };
      const exported = await source.exportTextCheckpoint({ sessionID });
      expect(exported.execution?.data).toEqual({
        mode: mode === "guarded" ? "guarded" : "build",
        planEnabled: true,
      });
      expect(exported.inputs[0]?.payload.conversationInputIntent).toEqual(intent);
      expect(exported.messages[0]?.info.metadata).toEqual({ conversationInputIntent: intent });
      expect(JSON.stringify(exported)).not.toContain("SYNTHETIC_PRIVATE_LOCAL_STATE");
      await target.importTextCheckpoint({
        checkpoint: exported,
        target: { directory: root, projectID: "target" },
      });
      expect(await target.exportTextCheckpoint({ sessionID })).toEqual(exported);
      expect((await target.getSession(sessionID))?.permission).toBeUndefined();
      expect(await target.sessionEntries({ sessionID })).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "runtime/permission_full_access" }),
        ]),
      );
      expect(await target.listSessionInputs({ sessionID, status: "admitted" })).toEqual([]);
      expect(exported.messages[1]?.parts).toContainEqual(
        expect.objectContaining({
          type: "tool",
          state: expect.objectContaining({
            output: "public result",
            metadata: { schemaVersion: 1 },
          }),
        }),
      );
      // 同 ID 的继续恢复也须清除目标原有放行，不能只验证空库首次导入。
      await target.saveSessionEntry({
        id: "target-grant",
        sessionID,
        type: "runtime/permission_full_access",
        time: { created: 1, updated: 2 },
        data: {},
      });
      await target.saveSessionEntry({
        id: "execution",
        sessionID,
        type: "runtime/execution_state",
        time: { created: 1, updated: 2 },
        data: { mode: "yolo", planEnabled: true },
      });
      const operation = randomUUID();
      const targetIdentity = { directory: root, projectID: "target" };
      await target.controlContinuation(
        { kind: "close", session: sessionID, operation },
        targetIdentity,
      );
      await target.controlContinuation(
        {
          kind: "stage",
          session: sessionID,
          operation,
          branchMode: "primary",
          management: { titleOverride: null, archived: false, deleted: false, pinned: false },
          dataBase64: Buffer.from(JSON.stringify(exported)).toString("base64"),
        },
        targetIdentity,
      );
      await target.controlContinuation(
        { kind: "apply", session: sessionID, operation },
        targetIdentity,
      );
      expect(
        await target.sessionEntries({ sessionID, type: "runtime/permission_full_access" }),
      ).toEqual([]);
      expect(await target.exportTextCheckpoint({ sessionID })).toEqual(exported);
      expect({
        session: await source.getSession(sessionID),
        messages: await source.messages({ sessionID }),
        entries: await source.sessionEntries({ sessionID }),
        inputs: await source.listSessionInputs({ sessionID }),
      }).toEqual(before);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "session.text_checkpoint",
          status: "completed",
          localOnlyEntryCount: 3,
        }),
      );
      expect(JSON.stringify(events)).not.toMatch(/SYNTHETIC_PRIVATE/);
      target.close();
      targetClosed = true;
      const reopened = await createSqliteSessionStore({ dbPath: targetPath });
      try {
        expect(await reopened.exportTextCheckpoint({ sessionID })).toEqual(exported);
        expect(
          (await reopened.sessionEntries({ sessionID, type: "runtime/execution_state" }))[0]?.data,
        ).toEqual(exported.execution?.data);
      } finally {
        reopened.close();
      }
    } finally {
      source.close();
      if (!targetClosed) target.close();
    }
  },
);

it("does not accept elevated checkpoint execution, arbitrary modes, or replayable inputs", () => {
  const cp = checkpoint();
  for (const mode of ["yolo", "edit", "auto", "unknown"]) {
    expect(
      textCheckpointSchema.safeParse({
        ...cp,
        version: 4,
        execution: {
          id: "execution",
          time: { created: 1, updated: 2 },
          data: { mode, planEnabled: false },
        },
      }).success,
    ).toBe(false);
  }
  expect(
    textCheckpointSchema.safeParse({
      ...cp,
      inputs: [
        {
          id: "pending",
          kind: "prompt",
          delivery: "startNow",
          payload: { text: "synthetic" },
          admittedSequence: 0,
          status: "admitted",
          time: { created: 1, updated: 2 },
        },
      ],
    }).success,
  ).toBe(false);
});

it.each(["entry", "execution", "tool-metadata"])(
  "still rejects unknown necessary %s state",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-unknown-"));
    roots.push(root);
    const store = await createSqliteSessionStore({ dbPath: join(root, "source.sqlite") });
    const cp = checkpoint();
    const sessionID = cp.session.id as SessionId;
    try {
      await store.importTextCheckpoint({
        checkpoint: cp,
        target: { directory: root, projectID: "source" },
      });
      if (kind === "tool-metadata") {
        await store.savePart({
          id: "tool-unknown",
          sessionID,
          messageID: cp.messages[1]!.info.id,
          type: "tool",
          tool: "read_file",
          callID: "call",
          metadata: { schemaVersion: 1, unknownNecessaryState: true },
          state: {
            status: "completed",
            input: {},
            output: "result",
            title: "Read",
            metadata: { schemaVersion: 1 },
            time: { start: 1, end: 2 },
          },
        });
      } else {
        await store.saveSessionEntry({
          id: "unknown",
          sessionID,
          type: kind === "entry" ? "future/required" : "runtime/execution_state",
          time: { created: 1, updated: 2 },
          data: { mode: "future", planEnabled: false },
        });
      }
      await expect(store.exportTextCheckpoint({ sessionID })).rejects.toMatchObject({
        code: "unsupported_state",
      });
    } finally {
      store.close();
    }
  },
);
