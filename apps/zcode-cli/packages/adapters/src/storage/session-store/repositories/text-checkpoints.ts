import {
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_EXECUTION_STATE,
  TextCheckpointError,
  textCheckpointSchema,
  type Logger,
  type MessageInfo,
  type MessageId,
  type MessagePart,
  type SessionId,
  type TextCheckpoint,
  type TextCheckpointStorePort,
  type TraceId,
} from "@zcode/contracts";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { projectTextCheckpoint, checkpointOriginSchema } from "../text-checkpoint-projection.js";
import { messagesSync, saveMessageSync, savePartSync } from "./messages.js";
import { saveSessionEntry, sessionEntries } from "./session-entries.js";
import { listSessionInputsSync } from "./session-inputs.js";
import { createSession, getSession } from "./sessions.js";

function observe<T>(
  phase: "export" | "import",
  logger: Logger | undefined,
  run: (log?: Logger) => T,
): T {
  const log = logger?.child({ event: "session.text_checkpoint", phase, operationId: randomUUID() });
  log?.info("Text checkpoint started", { status: "started" });
  try {
    return run(log);
  } catch (cause) {
    const error =
      cause instanceof TextCheckpointError
        ? cause
        : new TextCheckpointError("storage_failure", { cause });
    // 不传原始校验错误 / SQL 错误，避免 payload、路径或正文进入普通日志。
    log?.warn("Text checkpoint rejected", {
      event: "session.text_checkpoint",
      phase,
      status: "failed",
      code: error.code,
    });
    throw error;
  }
}

export function exportTextCheckpoint(
  db: DatabaseSync,
  input: { sessionID: SessionId },
  logger?: Logger,
): TextCheckpoint {
  return observe("export", logger, (log) => {
    db.exec("begin");
    let result: TextCheckpoint;
    try {
      const session = getSession(db, input.sessionID);
      if (!session) throw new TextCheckpointError("session_not_found");
      // 这些必要状态尚无文本格式；不能只因 message 是 text 就漏掉旁路事实。
      for (const table of ["session_target"]) {
        if (db.prepare(`select 1 from ${table} where session_id = ? limit 1`).get(session.id)) {
          throw new TextCheckpointError("unsupported_state");
        }
      }
      result = projectTextCheckpoint(
        session,
        messagesSync(db, input),
        sessionEntries(db, input),
        listSessionInputsSync(db, input),
        db
          .prepare(
            "select content,status,priority,position,time_created as created,time_updated as updated from todo where session_id=? order by position",
          )
          .all(session.id),
        log,
      );
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    log?.info("Text checkpoint exported", {
      event: "session.text_checkpoint",
      phase: "export",
      status: "completed",
      sessionId: result.session.id,
      traceId: result.session.traceID as TraceId | undefined,
      messageCount: result.messages.length,
      inputCount: result.inputs.length,
    });
    return result;
  });
}

export function importTextCheckpoint(
  db: DatabaseSync,
  input: Parameters<TextCheckpointStorePort["importTextCheckpoint"]>[0],
  logger?: Logger,
  replaceInsideTransaction = false,
): void {
  observe("import", logger, (log) => {
    const parsed = textCheckpointSchema.safeParse(input.checkpoint);
    const target = input.target;
    if (
      !parsed.success ||
      !target ||
      typeof target.directory !== "string" ||
      !isAbsolute(target.directory) ||
      typeof target.projectID !== "string" ||
      !target.projectID.trim() ||
      (target.workspaceID !== undefined &&
        (typeof target.workspaceID !== "string" || !target.workspaceID.trim()))
    ) {
      throw new TextCheckpointError("invalid_checkpoint");
    }
    const checkpoint = parsed.data;
    const sessionID = checkpoint.session.id as SessionId;
    if (!replaceInsideTransaction) db.exec("begin immediate");
    try {
      if (replaceInsideTransaction) {
        // 唯一恢复 writer 复用；外层必须持有持久屏障和同一 SQLite 事务。
        for (const table of ["part", "message", "session_entry", "session_input", "todo"])
          db.prepare(`delete from ${table} where session_id = ?`).run(sessionID);
        db.prepare("update session set permission = null where id = ?").run(sessionID);
      }
      const identities: Array<[string, string[]]> = [
        ...(replaceInsideTransaction ? [] : [["session", [sessionID]] as [string, string[]]]),
        ["message", checkpoint.messages.map(({ info }) => info.id)],
        [
          "part",
          checkpoint.messages.flatMap(({ parts }) =>
            parts.flatMap((part) => [
              part.id,
              ...(part.type === "tool" && part.state.status === "completed"
                ? (part.state.attachments ?? []).map((file) => file.id)
                : []),
            ]),
          ),
        ],
        [
          "session_entry",
          [
            "checkpoint-origin:" + sessionID,
            checkpoint.modelSelectionEntryId,
            ...(checkpoint.execution ? [checkpoint.execution.id] : []),
            ...(checkpoint.commandFacts ?? []).map((fact) => fact.id),
            ...(checkpoint.branchEffects !== undefined ? ["branch-effects:" + sessionID] : []),
          ].flat(),
        ],
        ["session_input", checkpoint.inputs.map((input) => input.id)],
      ];
      for (const [table, keys] of identities) {
        const exists = db.prepare(`select 1 from ${table} where id = ?`);
        for (const key of keys)
          if (exists.get(key)) throw new TextCheckpointError("identity_conflict");
      }
      createSession(db, {
        ...checkpoint.session,
        id: sessionID,
        traceID: checkpoint.session.traceID as TraceId | undefined,
        projectID: target.projectID,
        workspaceID: target.workspaceID,
        directory: target.directory,
        path: target.directory,
        taskType: checkpoint.session.taskType ?? "interactive",
        parentID: checkpoint.session.parentID as SessionId | undefined,
        titleMessageID: checkpoint.session.titleMessageID as MessageId | undefined,
      });
      if (checkpoint.session.revert)
        db.prepare("update session set revert=? where id=?").run(
          JSON.stringify(checkpoint.session.revert),
          sessionID,
        );
      db.prepare(
        "update session set last_outcome=?,last_outcome_input_id=?,last_outcome_at=? where id=?",
      ).run(
        checkpoint.session.lastOutcome ?? null,
        checkpoint.session.lastOutcomeInputId ?? null,
        checkpoint.session.lastOutcomeAt ?? null,
        sessionID,
      );
      for (const { info, parts } of checkpoint.messages) {
        saveMessageSync(db, {
          ...info,
          sessionID,
          ...(info.role === "assistant"
            ? { path: { cwd: target.directory, root: target.directory } }
            : {}),
        } as MessageInfo);
        for (const part of parts)
          savePartSync(db, {
            ...part,
            ...(part.type === "tool" && part.state.status === "completed" && part.state.attachments
              ? {
                  state: {
                    ...part.state,
                    attachments: part.state.attachments.map((file) => ({
                      ...file,
                      sessionID,
                      messageID: info.id,
                    })),
                  },
                }
              : {}),
            sessionID,
            messageID: info.id,
          } as MessagePart);
      }
      saveSessionEntry(db, {
        id: checkpoint.modelSelectionEntryId,
        sessionID,
        type: SESSION_ENTRY_MODEL_SELECTION,
        time: checkpoint.session.time,
        data: checkpoint.modelSelection,
        touchSession: false,
      });
      if (checkpoint.branchEffects !== undefined)
        saveSessionEntry(db, {
          id: "branch-effects:" + sessionID,
          sessionID,
          type: "runtime/branch_effects",
          data: checkpoint.branchEffects,
          time: checkpoint.session.time,
          touchSession: false,
        });
      for (const fact of checkpoint.commandFacts ?? [])
        saveSessionEntry(db, { ...fact, sessionID, type: "v4/command_fact", touchSession: false });
      if (checkpoint.execution)
        saveSessionEntry(db, {
          ...checkpoint.execution,
          sessionID,
          type: SESSION_ENTRY_EXECUTION_STATE,
          touchSession: false,
        });
      for (const todo of checkpoint.todos ?? [])
        db.prepare(
          "insert into todo(session_id,content,status,priority,position,time_created,time_updated) values(?,?,?,?,?,?,?)",
        ).run(
          sessionID,
          todo.content,
          todo.status,
          todo.priority,
          todo.position,
          todo.created,
          todo.updated,
        );
      const insert = db.prepare(`insert into session_input
        (id, session_id, kind, delivery, payload, admitted_sequence, promoted_sequence,
         promoted_message_id, status, status_reason, time_created, time_updated)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const fact of checkpoint.inputs)
        insert.run(
          fact.id,
          sessionID,
          fact.kind,
          fact.delivery,
          JSON.stringify(fact.payload),
          fact.admittedSequence,
          fact.promotedSequence ?? null,
          fact.promotedMessageID ?? null,
          fact.status,
          fact.statusReason ?? null,
          fact.time.created,
          fact.time.updated,
        );
      // 插入 parts 会 touchSession；导入完成回到准确来源水位，而非把导入当新业务活动。
      db.prepare("update session set time_updated = ? where id = ?").run(
        checkpoint.session.time.updated,
        sessionID,
      );
      const observed = getSession(db, sessionID)!;
      saveSessionEntry(db, {
        id: "checkpoint-origin:" + sessionID,
        sessionID,
        type: "runtime/checkpoint_origin",
        time: checkpoint.session.time,
        touchSession: false,
        data: checkpointOriginSchema.parse({
          missingTitleSource: checkpoint.session.titleSource === undefined,
          missingTitleMessageID: checkpoint.session.titleMessageID === undefined,
          title: checkpoint.session.title,
          titleSource: observed.titleSource ?? null,
          titleMessageID: observed.titleMessageID ?? null,
        }),
      });
      if (!replaceInsideTransaction) db.exec("commit");
    } catch (error) {
      if (!replaceInsideTransaction) db.exec("rollback");
      throw error;
    }
    log?.info("Text checkpoint imported", {
      event: "session.text_checkpoint",
      phase: "import",
      status: "completed",
      sessionId: sessionID,
      messageCount: checkpoint.messages.length,
      inputCount: checkpoint.inputs.length,
    });
  });
}
