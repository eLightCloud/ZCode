import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { ConversationSyncError, syncScopeSchema, type SyncScope, type Logger } from "@zcode/contracts";
import {
  conversationTerminalAcknowledgementSchema, conversationTerminalReportSchema,
  conversationTerminalMonitoringSchema, CONVERSATION_TERMINAL_FRESHNESS_MS,
} from "@zcode/shared";
import { requireRuntimeScope } from "./runtime-scope.js";
import { canonical } from "./canonical.js";

export function createConversationTerminalStore(options: { pool: Pool; logger: Logger }) {
  return {
    async report(scope: SyncScope, source: string, kind: "desktop" | "server", raw: unknown, correlationId?: string) {
      const checked = syncScopeSchema.parse(scope), parsed = conversationTerminalReportSchema.safeParse(raw);
      if (!parsed.success) throw new ConversationSyncError("invalid");
      const report = parsed.data;
      if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(source) || !["desktop", "server"].includes(kind)) throw new ConversationSyncError("invalid");
      const sourceRef = createHash("sha256").update(canonical([checked.tenant, checked.subject, source])).digest("hex");
      const client = await options.pool.connect();
      try {
        await client.query("begin");
        await requireRuntimeScope(client, checked);
        const prior = (await client.query("select sequence,snapshot from zcode_sync.terminals where source=$1 for update", [source])).rows[0];
        const result = await client.query(`insert into zcode_sync.terminals values($1,$2,$3,$4,$5,$6,clock_timestamp(),$7)
          on conflict(tenant,subject,source) do update set source_ref=excluded.source_ref,kind=excluded.kind,
          sequence=excluded.sequence,received_at=excluded.received_at,snapshot=excluded.snapshot
          where zcode_sync.terminals.sequence<excluded.sequence returning sequence`,
          [checked.tenant, checked.subject, source, sourceRef, kind, report.sequence, report]);
        const previous = result.rowCount ? null : (await client.query("select sequence,snapshot from zcode_sync.terminals where source=$1", [source])).rows[0];
        const accepted = !!result.rowCount || canonical(previous?.snapshot) === canonical(report);
        const sequence = result.rowCount ? report.sequence : Number(previous.sequence);
        await client.query("commit");
        const changed = !prior || prior.snapshot.phase !== report.phase || prior.snapshot.queue.items !== report.queue.items ||
          prior.snapshot.error !== report.error || prior.snapshot.recovery.lastCaughtUpAt !== report.recovery.lastCaughtUpAt;
        const fields = { ...(correlationId && /^[a-f0-9]{32}$/.test(correlationId) ? { correlationId } : {}), event: "conversation.sync.terminal.report", sourceRef, outcome: accepted ? "accepted" : "stale", sequence };
        if (accepted && changed) options.logger.info("Terminal observation changed", fields);
        else options.logger.debug("Terminal observation received", fields);
        return conversationTerminalAcknowledgementSchema.parse({ accepted, sequence, sourceRef });
      } catch (cause) { await client.query("rollback"); throw cause; }
      finally { client.release(); }
    },
  };
}

/** Configuration gets only metadata columns; RLS still protects the source keys. */
export async function readTerminalMonitoring(client: PoolClient, observedAt: Date) {
  const threshold = new Date(observedAt.getTime() - CONVERSATION_TERMINAL_FRESHNESS_MS);
  const raw = (await client.query(`select count(*) as known,
    count(*) filter(where received_at >= $1) as fresh,
    count(*) filter(where received_at < $1) as stale,
    coalesce(sum((snapshot->'queue'->>'items')::bigint) filter(where received_at >= $1),0) as fresh_items,
    coalesce(sum((snapshot->'queue'->>'items')::bigint) filter(where received_at < $1),0) as stale_items,
    coalesce(sum((snapshot->'queue'->>'checkpointBytes')::bigint+(snapshot->'queue'->>'fileBytes')::bigint) filter(where received_at >= $1),0) as bytes,
    count(*) filter(where received_at >= $1 and (snapshot->>'phase'='blocked' or jsonb_array_length(snapshot->'localReasons')>0 or jsonb_array_length(snapshot->'reasons')>0)) as blocked,
    count(*) filter(where received_at >= $1 and snapshot->>'phase'='waiting_retry') as retrying,
    count(*) filter(where received_at >= $1 and snapshot->>'phase'='caught_up') as caught_up,
    max((snapshot->'recovery'->>'lastCaughtUpAt')::timestamptz) as caught_up_at from zcode_sync.terminals`, [threshold])).rows[0];
  const rows = (await client.query("select source_ref,kind,received_at,snapshot from zcode_sync.terminals order by received_at desc,source_ref limit 100")).rows;
  return conversationTerminalMonitoringSchema.parse({
    freshnessMs: CONVERSATION_TERMINAL_FRESHNESS_MS,
    knownSources: Number(raw.known), freshSources: Number(raw.fresh), staleSources: Number(raw.stale),
    freshPendingItems: Number(raw.fresh_items), stalePendingItems: Number(raw.stale_items), freshPendingBytes: Number(raw.bytes),
    freshBlockedSources: Number(raw.blocked), freshRetryingSources: Number(raw.retrying), freshCaughtUpSources: Number(raw.caught_up),
    latestCaughtUpAt: raw.caught_up_at?.toISOString() ?? null,
    sources: rows.map(row => ({ sourceRef: row.source_ref, kind: row.kind, receivedAt: row.received_at.toISOString(), fresh: row.received_at >= threshold, report: row.snapshot })),
  });
}
