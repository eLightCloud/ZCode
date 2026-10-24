import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Logger, SessionId, SessionContinuationStorePort } from "@zcode/contracts";
import { textCheckpointSchema } from "@zcode/contracts";
import {
  conversationRuntimeCommandSchema,
  conversationRuntimeResultSchema,
  type ConversationRuntimeResult,
  ConversationRuntimeError,
} from "@zcode/shared";
import { exportTextCheckpoint, importTextCheckpoint } from "./text-checkpoints.js";
import { getSession } from "./sessions.js";

type Row = {
  session_id: string;
  operation: string;
  state: ConversationRuntimeResult["state"];
  generation: number;
  version: string | null;
  digest: string | null;
  staged_json: string | null;
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
  db.exec("begin immediate");
  try {
    const read = () =>
      db.prepare("select * from session_continuation where session_id = ?").get(input.session) as
        | Row
        | undefined;
    let row = read();
    if (input.kind === "read") {
      if (!row) throw new ConversationRuntimeError("not_found");
      db.exec("commit");
      return result(row);
    }
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
    if (input.kind === "close") {
      if (row && !["active", "cancelled"].includes(row.state) && row.operation !== input.operation)
        throw new ConversationRuntimeError("operation_conflict");
      db.prepare(`insert into session_continuation(session_id,operation,state,generation)
        values(?,?,'closing',?) on conflict(session_id) do update set operation=excluded.operation,
        state='closing',digest=null,staged_json=null`).run(
        input.session,
        input.operation,
        row?.generation ?? 0,
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
        const checkpoint = textCheckpointSchema.parse(
          JSON.parse(Buffer.from(input.dataBase64, "base64").toString("utf8")),
        );
        if (checkpoint.session.id !== input.session)
          throw new ConversationRuntimeError("identity_conflict");
        if(input.management.deleted||input.management.pinned===undefined)throw new ConversationRuntimeError("management_unknown");
        const data = JSON.stringify({checkpoint,management:input.management});
        db.prepare(
          "update session_continuation set state='staged',digest=?,staged_json=? where session_id=?",
        ).run(hash(JSON.stringify(checkpoint)), data, input.session);
        output = result(read()!);
      } else if (input.kind === "apply") {
        if (row.state !== "staged" || !row.staged_json)
          throw new ConversationRuntimeError("state_conflict");
        const old = getSession(db, input.session as SessionId);
        if (old && (old.directory !== target.directory || old.workspaceID || old.parentID))
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
        importTextCheckpoint(db, { checkpoint: JSON.parse(row.staged_json).checkpoint, target }, logger, true);
        db.prepare(
          "update session_continuation set state='applied',staged_json=null where session_id=?",
        ).run(input.session);
        output = {...result(read()!),management:JSON.parse(row.staged_json).management};
      } else if (input.kind === "activate") {
        if (!["closed", "applied"].includes(row.state))
          throw new ConversationRuntimeError("state_conflict");
        if (input.generation <= row.generation)
          throw new ConversationRuntimeError("generation_stale");
        db.prepare(
          "update session_continuation set state='active',generation=?,version=? where session_id=?",
        ).run(input.generation, input.version, input.session);
        output = result(read()!);
      } else {
        if (!["closing", "closed"].includes(row.state))
          throw new ConversationRuntimeError("forward_only");
        db.prepare("update session_continuation set state='cancelled' where session_id=?").run(
          input.session,
        );
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
