import type { PoolClient } from "pg";
import type {
  ConversationContinuationJournal,
  ConversationContinuationRecord,
} from "@zcode/shared";
import {
  conversationContinuationIntentSchema,
  conversationContinuationRecordSchema,
  conversationContinuationResultSchema,
} from "@zcode/shared";
import { ConversationSyncError, syncStateSchema, type SyncScope } from "@zcode/contracts";
import { canonical, digest } from "./canonical.js";

type Transaction = <T>(scope: SyncScope, work: (client: PoolClient) => Promise<T>) => Promise<T>;
function record(row: {
  input_json: unknown;
  result_json: unknown;
}): ConversationContinuationRecord {
  return conversationContinuationRecordSchema.parse({
    intent: row.input_json,
    result: row.result_json,
  });
}
export function continuationJournal(transaction: Transaction): ConversationContinuationJournal {
  async function latch(
    scope: SyncScope,
    session: string,
    operation: string,
    status: "cancelling" | "forward_only",
  ) {
    return transaction(scope, async (client) => {
      await client.query("select session from zcode_sync.sessions where session=$1 for update", [
        session,
      ]);
      const rows = await client.query(
        "select * from zcode_sync.continuations where session=$1 and operation=$2 for update",
        [session, operation],
      );
      if (!rows.rowCount) throw new ConversationSyncError("not_found");
      const item = record(rows.rows[0]);
      if (item.result) return item;
      if (status === "forward_only" && item.intent.kind !== "offline")
        throw new ConversationSyncError("invalid");
      const result = conversationContinuationResultSchema.parse({
        session,
        operation,
        status,
        phase: status === "cancelling" ? "settling" : "granted",
        location: item.intent.target,
        version: item.intent.version,
      });
      await client.query(
        "update zcode_sync.continuations set result_json=$3 where session=$1 and operation=$2",
        [session, operation, canonical(result)],
      );
      return { ...item, result };
    });
  }
  return {
    offlineLocations: (scope, session) =>
      transaction(scope, async (client) => {
        const result = await client.query(
          `select distinct input_json->>'target' as location from zcode_sync.continuations
        where session=$1 and input_json->>'kind'='offline' and result_json->>'status'='ready'
          and ordinal>coalesce((select max(ordinal) from zcode_sync.continuations where session=$1
            and input_json->>'kind'<>'offline' and result_json->>'status'='ready'),0)`,
          [session],
        );
        return result.rows.map((row) => String(row.location));
      }),
    requestCancel: (scope, session, operation) => latch(scope, session, operation, "cancelling"),
    commitOffline: (scope, session, operation) => latch(scope, session, operation, "forward_only"),
    begin: (scope, raw, enrollment = false) =>
      transaction(scope, async (client) => {
        const input = conversationContinuationIntentSchema.parse(raw);
        const session = await client.query(
          "select state from zcode_sync.sessions where session=$1 for update",
          [input.session],
        );
        if (!session.rowCount) throw new ConversationSyncError("not_found");
        const previous = await client.query(
          "select * from zcode_sync.continuations where session=$1 and operation=$2",
          [input.session, input.operation],
        );
        if (previous.rowCount) {
          if (previous.rows[0].fingerprint !== digest(input))
            throw new ConversationSyncError("conflict");
          return record(previous.rows[0]);
        }
        const pending = await client.query(
          "select 1 from zcode_sync.continuations where session=$1 and (result_json is null or result_json->>'status' in ('forward_only','cancelling'))",
          [input.session],
        );
        if (pending.rowCount) throw new ConversationSyncError("blocked");
        const state = syncStateSchema.parse(session.rows[0].state);
        if(enrollment) {
          const offline=await client.query(`select 1 from zcode_sync.continuations where session=$1 and input_json->>'kind'='offline'
            and result_json->>'status'='ready' and ordinal>coalesce((select max(ordinal) from zcode_sync.continuations where session=$1
              and input_json->>'kind'<>'offline' and result_json->>'status'='ready'),0) limit 1`,[input.session]);
          if(state.active || state.pending || state.selected || state.candidates.length!==1 || offline.rowCount)
            throw new ConversationSyncError("blocked");
        }
        if (
          state.revision !== input.revision ||
          canonical([...state.candidates].sort()) !==
            canonical([...new Set(input.candidates)].sort())
        )
          throw new ConversationSyncError("stale");
        if (input.kind !== "handoff" && !state.candidates.includes(input.version))
          throw new ConversationSyncError("stale");
        if (
          input.kind === "handoff" &&
          (!state.active ||
            state.active.version !== input.version ||
            state.active.location === input.target)
        )
          throw new ConversationSyncError("blocked");
        if (state.pending || ["requested", "granted"].includes(state.handoff?.phase ?? ""))
          throw new ConversationSyncError("blocked");
        await client.query(
          "insert into zcode_sync.continuations(tenant,subject,session,operation,fingerprint,input_json,result_json) values($1,$2,$3,$4,$5,$6,null)",
          [
            scope.tenant,
            scope.subject,
            input.session,
            input.operation,
            digest(input),
            canonical(input),
          ],
        );
        return { intent: input, result: null };
      }),
    read: (scope, session, operation) =>
      transaction(scope, async (client) => {
        const value = await client.query(
          "select input_json,result_json from zcode_sync.continuations where session=$1 and " +
            (operation
              ? "operation=$2"
              : "(result_json is null or result_json->>'status' in ('forward_only','cancelling'))"),
          operation ? [session, operation] : [session],
        );
        return value.rowCount ? record(value.rows[0]) : null;
      }),
    finish: (scope, raw) =>
      transaction(scope, async (client) => {
        const input = conversationContinuationResultSchema.parse(raw);
        if (!["ready", "cancelled"].includes(input.status))
          throw new ConversationSyncError("invalid");
        const row = await client.query(
          "select * from zcode_sync.continuations where session=$1 and operation=$2 for update",
          [input.session, input.operation],
        );
        if (!row.rowCount) throw new ConversationSyncError("not_found");
        if (
          row.rows[0].result_json &&
          canonical(row.rows[0].result_json) !== canonical(input) &&
          !(
            (row.rows[0].result_json.status === "forward_only" && input.status === "ready") ||
            (row.rows[0].result_json.status === "cancelling" && input.status === "cancelled")
          )
        )
          throw new ConversationSyncError("conflict");
        await client.query(
          "update zcode_sync.continuations set result_json=$3 where session=$1 and operation=$2",
          [input.session, input.operation, canonical(input)],
        );
        return record({ ...row.rows[0], result_json: input });
      }),
  };
}
