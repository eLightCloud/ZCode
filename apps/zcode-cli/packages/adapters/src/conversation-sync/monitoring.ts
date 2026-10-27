import { requireRuntimeScope } from "./runtime-scope.js";
import { readTerminalMonitoring } from "./terminals.js";
import type { Pool, PoolClient } from "pg";
import { ConversationSyncError, type Logger } from "@zcode/contracts";
import {
  conversationMonitoringSchema, conversationObservationSchema,
  type ConversationObservation, type ConversationCenterConfiguration,
} from "@zcode/shared";

/** Refines diagnostics while preserving existing transport error codes. */
export class SyncDiagnosticError extends ConversationSyncError {
  constructor(code: "limit" | "storage", readonly reason: ConversationObservation["reason"]) {
    super(code);
  }
}

export async function readMonitoring(client: PoolClient, configuration: ConversationCenterConfiguration) {
  const timing = (await client.query(`select transaction_timestamp() as now,
    date_trunc('hour',transaction_timestamp())-interval '23 hours' as start,
    monitoring_started_at as since from zcode_sync.configuration where singleton=true`)).rows[0];
  const capacity = (await client.query("select zcode_sync.capacity_summary($1,$2) as value", [
    configuration.policy.maxSubjectBytes, configuration.policy.maxVersionsPerSession,
  ])).rows[0].value;
  const rows = (await client.query(`select action,outcome,reason,sum(count)::text as count,
    max(last_observed_at) as last from zcode_sync.observations where hour >= $1
    group by action,outcome,reason order by action,outcome,reason`, [timing.start])).rows;
  return conversationMonitoringSchema.parse({
    observedAt: timing.now.toISOString(), startedAt: timing.since.toISOString(),
    windowStartedAt: timing.start.toISOString(), configuration, capacity,
    terminals: await readTerminalMonitoring(client, timing.now),
    collectionAvailable: false, processStartedAt: null, unrecordedRequests: 0,
    lastPersistFailureAt: null,
    requests: rows.map(row => ({ action: row.action, outcome: row.outcome, reason: row.reason,
      count: Number(row.count), lastObservedAt: row.last.toISOString() })),
  });
}

/** Best-effort observation after the HTTP result; never retries a business request. */
export function createConversationSyncMonitor(options: { pool: Pool; logger: Logger }) {
  const processStartedAt = new Date().toISOString();
  let unrecordedRequests = 0, lastPersistFailureAt: string | null = null;
  return {
    collection: () => ({ collectionAvailable: true, processStartedAt, unrecordedRequests, lastPersistFailureAt }),
    async record(raw: ConversationObservation, correlationId?: string) {
      const value = conversationObservationSchema.parse(raw);
      try {
        const client = await options.pool.connect();
        try {
          await requireRuntimeScope(client);
          await client.query(`insert into zcode_sync.observations values(
            date_trunc('hour',clock_timestamp()),$1,$2,$3,1,clock_timestamp())
            on conflict(hour,action,outcome,reason) do update
            set count=zcode_sync.observations.count+1,last_observed_at=excluded.last_observed_at`,
            [value.action, value.outcome, value.reason]);
        } finally { client.release(); }
      } catch {
        unrecordedRequests++; lastPersistFailureAt = new Date().toISOString();
        options.logger.warn("Conversation observation unrecorded", {
          ...(correlationId && /^[a-f0-9]{32}$/.test(correlationId) ? { correlationId } : {}),
          event: "conversation.sync.observation", outcome: "unconfirmed", code: "storage",
        });
      }
    },
  };
}
