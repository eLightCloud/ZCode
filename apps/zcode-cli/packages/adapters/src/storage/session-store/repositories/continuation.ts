import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Logger, SessionId, SessionContinuationStorePort } from "@zcode/contracts";
import { textCheckpointSchema, checkpointArtifactUris } from "@zcode/contracts";
import {
  conversationRuntimeCommandSchema,
  conversationRuntimeResultSchema,
  type ConversationRuntimeResult,
  ConversationRuntimeError,
} from "@zcode/shared";
import { exportTextCheckpoint, importTextCheckpoint } from "./text-checkpoints.js";
import { saveSessionEntry, sessionEntries } from "./session-entries.js";
import { getSession } from "./sessions.js";

type Row = {
  session_id: string;
  operation: string;
  state: ConversationRuntimeResult["state"];
  generation: number;
  version: string | null;
  digest: string | null;
  staged_json: string | null;
  files_json: string | null;
  prior_json: string | null;
  branch_mode: "primary" | "offline";
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function result(row: Row): ConversationRuntimeResult {
  return conversationRuntimeResultSchema.parse({
    session: row.session_id,
    operation: row.operation,
    state: row.state,
    generation: row.generation,
    version: row.version,
    digest: row.digest,
    branchMode: row.branch_mode,
    ...(row.files_json ? { files: JSON.parse(row.files_json) } : {}),
  });
}
/** Same session-store owner and writer as admission/import. No remote leases are inferred here. */
export function controlContinuation(
  db: DatabaseSync,
  raw: Parameters<SessionContinuationStorePort["controlContinuation"]>[0],
  target: Parameters<SessionContinuationStorePort["controlContinuation"]>[1],
  logger?: Logger,
) {
  const input = conversationRuntimeCommandSchema.parse(raw);
  const fingerprint = hash(JSON.stringify(input));
  if (input.kind === "read") {
    const row = db
      .prepare("select * from session_continuation where session_id=?")
      .get(input.session) as Row | undefined;
    if (!row) throw new ConversationRuntimeError("not_found");
    return result(row);
  }
  if (input.kind === "effects") {
    db.exec("begin immediate");
    try {
      const row = db
        .prepare("select * from session_continuation where session_id=?")
        .get(input.session) as Row | undefined;
      if (
        !row ||
        row.operation !== input.operation ||
        row.generation !== input.generation ||
        row.state !== "active"
      )
        throw new ConversationRuntimeError("admission_closed");
      const previous = sessionEntries(db, {
        sessionID: input.session as SessionId,
        type: "runtime/branch_effects",
      })[0];
      const revision =
        previous?.data && typeof previous.data === "object" && "revision" in previous.data
          ? Number(previous.data.revision)
          : -1;
      if (
        input.revision === revision &&
        previous?.data &&
        typeof previous.data === "object" &&
        "effects" in previous.data &&
        hash(JSON.stringify(previous.data.effects)) !== hash(JSON.stringify(input.effects))
      )
        throw new ConversationRuntimeError("operation_conflict");
      if (input.revision >= revision)
        saveSessionEntry(db, {
          id: "branch-effects:" + input.session,
          sessionID: input.session as SessionId,
          type: "runtime/branch_effects",
          time: { created: previous?.time.created ?? Date.now(), updated: Date.now() },
          data: { revision: input.revision, effects: input.effects },
          touchSession: false,
        });
      db.exec("commit");
      return result(row);
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
  db.exec("begin immediate");
  try {
    const read = () =>
      db.prepare("select * from session_continuation where session_id = ?").get(input.session) as
        | Row
        | undefined;
    let row = read();
    const prior = db
      .prepare(
        "select fingerprint,result_json from session_continuation_receipt where session_id=? and operation=? and kind=?",
      )
      .get(input.session, input.operation, input.kind) as
      | { fingerprint: string; result_json: string }
      | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new ConversationRuntimeError("operation_conflict");
      db.exec("commit");
      return conversationRuntimeResultSchema.parse(JSON.parse(prior.result_json));
    }
    let output: ConversationRuntimeResult;
    if (
      input.kind === "cancel" &&
      !row &&
      input.generation === undefined &&
      input.version === undefined
    ) {
      // Host 的索引关闸可能先成功；即便 Core 尚未写入 close，也持久确认这次取消。
      db.prepare(
        "insert into session_continuation(session_id,operation,state) values(?,?,'cancelled')",
      ).run(input.session, input.operation);
      output = result(read()!);
    } else if (
      input.kind === "cancel" &&
      row?.operation !== input.operation &&
      input.generation === undefined &&
      input.version === undefined
    ) {
      // 原生 close 尚未发生时，取消只确认当前原状态；不能解开别的操作持有的屏障。
      output = result(row!);
    } else if (input.kind === "close") {
      if (
        row &&
        !["active", "cancelled"].includes(row.state) &&
        row.operation !== input.operation &&
        (input.supersedeOperation !== row.operation || row.state === "applied")
      )
        throw new ConversationRuntimeError("operation_conflict");
      const prior = row ? JSON.stringify({ ...row, staged_json: null, prior_json: null }) : null;
      db.prepare(`insert into session_continuation(session_id,operation,state,generation,prior_json)
        values(?,?,'closing',?,?) on conflict(session_id) do update set operation=excluded.operation,
        state='closing',digest=null,staged_json=null,prior_json=excluded.prior_json`).run(
        input.session,
        input.operation,
        row?.generation ?? 0,
        prior,
      );
      output = result(read()!);
    } else {
      if (!row || row.operation !== input.operation)
        throw new ConversationRuntimeError("operation_conflict");
      if (input.kind === "capture") {
        if (!["closing", "closed"].includes(row.state))
          throw new ConversationRuntimeError("state_conflict");
        // Protocol owner has settled and retired the App before this call.
        // Export reuses a nested read snapshot below, outside this write transaction.
        db.exec("commit");
        const checkpoint = exportTextCheckpoint(
          db,
          { sessionID: input.session as SessionId },
          logger,
        );
        const data = JSON.stringify(checkpoint),
          digest = hash(data);
        db.exec("begin immediate");
        row = read();
        if (!row || row.operation !== input.operation || !["closing", "closed"].includes(row.state))
          throw new ConversationRuntimeError("operation_conflict");
        db.prepare(
          "update session_continuation set state='closed',digest=? where session_id=?",
        ).run(digest, input.session);
        output = { ...result(read()!), dataBase64: Buffer.from(data).toString("base64") };
      } else if (input.kind === "stage") {
        if (!["closing", "closed", "staged"].includes(row.state))
          throw new ConversationRuntimeError("state_conflict");
        const prior = row.prior_json ? (JSON.parse(row.prior_json) as Row) : null;
        if (
          input.branchMode === "offline" &&
          prior &&
          prior.generation > 0 &&
          prior.branch_mode === "primary"
        )
          throw new ConversationRuntimeError("forward_only");
        const checkpoint = textCheckpointSchema.parse(
          JSON.parse(Buffer.from(input.dataBase64, "base64").toString("utf8")),
        );
        if (checkpoint.session.id !== input.session)
          throw new ConversationRuntimeError("identity_conflict");
        if (input.management.deleted || input.management.pinned === undefined)
          throw new ConversationRuntimeError("management_unknown");
        const refs = checkpointArtifactUris(checkpoint),
          files = input.files ?? [];
        if (
          refs.length !== files.length ||
          refs.some((uri) => files.filter((file) => file.uri === uri).length !== 1)
        )
          throw new ConversationRuntimeError("artifact_manifest");
        const data = JSON.stringify({ checkpoint, management: input.management });
        db.prepare(
          "update session_continuation set state='staged',digest=?,staged_json=?,branch_mode=?,files_json=? where session_id=?",
        ).run(
          hash(JSON.stringify(checkpoint)),
          data,
          input.branchMode ?? "primary",
          JSON.stringify(input.files ?? []),
          input.session,
        );
        output = result(read()!);
      } else if (input.kind === "apply") {
        if (row.state !== "staged" || !row.staged_json)
          throw new ConversationRuntimeError("state_conflict");
        const old = getSession(db, input.session as SessionId);
        if (
          old &&
          (old.directory !== target.directory ||
            old.workspaceID ||
            !["interactive", "fork"].includes(old.taskType))
        )
          throw new ConversationRuntimeError("target_ineligible");
        // Existing target must itself be fully portable; never discard unknown state.
        if (old) {
          db.exec("commit");
          exportTextCheckpoint(db, { sessionID: input.session as SessionId }, logger);
          db.exec("begin immediate");
          row = read();
          if (
            !row ||
            row.operation !== input.operation ||
            row.state !== "staged" ||
            !row.staged_json
          )
            throw new ConversationRuntimeError("operation_conflict");
        }
        importTextCheckpoint(
          db,
          { checkpoint: JSON.parse(row.staged_json).checkpoint, target },
          logger,
          true,
        );
        db.prepare(
          "update session_continuation set state='applied',staged_json=null where session_id=?",
        ).run(input.session);
        output = { ...result(read()!), management: JSON.parse(row.staged_json).management };
      } else if (input.kind === "activateOffline") {
        if (row.state !== "applied" || row.branch_mode !== "offline")
          throw new ConversationRuntimeError("state_conflict");
        db.prepare(
          "update session_continuation set state='active',generation=0,version=? where session_id=?",
        ).run(input.version, input.session);
        output = result(read()!);
      } else if (input.kind === "activate") {
        if (!["closed", "applied"].includes(row.state))
          throw new ConversationRuntimeError("state_conflict");
        if (input.generation <= row.generation)
          throw new ConversationRuntimeError("generation_stale");
        db.prepare(
          "update session_continuation set state='active',generation=?,version=?,branch_mode='primary' where session_id=?",
        ).run(input.generation, input.version, input.session);
        output = result(read()!);
      } else {
        if (!["closing", "closed", "staged"].includes(row.state))
          throw new ConversationRuntimeError("forward_only");
        if (input.generation !== undefined || input.version !== undefined) {
          if (!input.generation || !input.version || input.generation <= row.generation)
            throw new ConversationRuntimeError("generation_stale");
          db.prepare(
            "update session_continuation set state='active',generation=?,version=?,staged_json=null where session_id=?",
          ).run(input.generation, input.version, input.session);
        } else if (row.prior_json) {
          const prior = JSON.parse(row.prior_json) as Row;
          db.prepare(
            "update session_continuation set operation=?,state=?,generation=?,version=?,digest=?,staged_json=null,prior_json=null,branch_mode=?,files_json=? where session_id=?",
          ).run(
            prior.operation,
            prior.state === "staged" ? "closed" : prior.state,
            prior.generation,
            prior.version,
            prior.digest,
            prior.branch_mode,
            prior.files_json,
            input.session,
          );
        } else
          db.prepare(
            "update session_continuation set state='cancelled',staged_json=null,prior_json=null where session_id=?",
          ).run(input.session);
        output = result(read()!);
      }
    }
    db.prepare("insert into session_continuation_receipt values(?,?,?,?,?)").run(
      input.session,
      input.operation,
      input.kind,
      fingerprint,
      JSON.stringify(output),
    );
    db.exec("commit");
    logger?.info("Native continuation transition", {
      event: "conversation.continuation.runtime",
      sessionId: input.session,
      operationId: input.operation,
      phase: input.kind,
      outcome: output.state,
    });
    return output;
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    logger?.warn("Native continuation rejected", {
      event: "conversation.continuation.runtime",
      sessionId: input.session,
      operationId: input.operation,
      phase: input.kind,
      outcome: "blocked",
    });
    throw error;
  }
}
