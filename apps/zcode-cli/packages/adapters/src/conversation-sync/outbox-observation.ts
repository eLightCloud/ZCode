import type { DatabaseSync } from "node:sqlite";
import { ConversationSyncError, syncScopeSchema } from "@zcode/contracts";
import type { SyncScope } from "@zcode/contracts";
import {
  conversationTerminalReasonSchema, conversationTerminalReportSchema,
  conversationTerminalRuntimeSchema,
  type ConversationTerminalReason, type ConversationTerminalRuntime,
} from "@zcode/shared";

export function migrateOutboxObservation(db: DatabaseSync) {
  db.exec(`alter table sync_outbox add column created_ms integer;
    alter table sync_outbox add column attempts integer not null default 0;
    alter table sync_outbox add column attempt_ms integer;
    alter table sync_outbox add column failure text;
    alter table sync_outbox add column acknowledged_ms integer;
    create table sync_reporting(tenant text not null,subject text not null,
      sequence integer not null default 0,peak integer not null default 0,
      ack_baseline integer not null default 0,last_caught_up_ms integer,
      last_recovered_items integer not null default 0,last_recovery_peak integer not null default 0,
      primary key(tenant,subject));`);
}
const values = (scope: SyncScope) => { const checked = syncScopeSchema.parse(scope); return [checked.tenant, checked.subject]; };
const iso = (value: unknown) => value === null || value === undefined ? null : new Date(Number(value)).toISOString();

/** Metadata is derived from this same SQLite transaction; no request identifiers leave it. */
export function outboxObservation(db: DatabaseSync) {
  const queued = (scope: SyncScope) => db.prepare("select count(*) as n from sync_outbox where tenant=? and subject=? and receipt is null").get(...values(scope))!;
  const acknowledged = (scope: SyncScope) => Number(db.prepare("select count(*) as n from sync_outbox where tenant=? and subject=? and receipt is not null").get(...values(scope))!.n);
  function owner(scope: SyncScope) {
    const row = db.prepare("select * from sync_reporting where tenant=? and subject=?").get(...values(scope));
    if (!row) throw new ConversationSyncError("stale");
    return row;
  }
  return {
    created(scope: SyncScope) {
      db.prepare("update sync_reporting set peak=max(peak,?) where tenant=? and subject=?").run(Number(queued(scope).n), ...values(scope));
    },
    start(scope: SyncScope) {
      db.prepare(`insert into sync_reporting(tenant,subject,peak,ack_baseline) values(?,?,?,?)
        on conflict(tenant,subject) do nothing`).run(...values(scope), Number(queued(scope).n), acknowledged(scope));
    },
    rebase(scope: SyncScope, expected: number, sequence: number) {
      if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) throw new ConversationSyncError("invalid");
      const result = db.prepare("update sync_reporting set sequence=max(sequence,?) where tenant=? and subject=? and sequence=?").run(sequence, ...values(scope), expected);
      if (!result.changes) throw new ConversationSyncError("stale");
    },
    attempt(scope: SyncScope, session: string, operation: string) {
      return !!db.prepare("update sync_outbox set attempts=attempts+1,attempt_ms=? where tenant=? and subject=? and session=? and operation=? and receipt is null").run(Date.now(), ...values(scope), session, operation).changes;
    },
    failed(scope: SyncScope, session: string, operation: string, reason: ConversationTerminalReason) {
      const checked = conversationTerminalReasonSchema.parse(reason);
      db.prepare("update sync_outbox set failure=? where tenant=? and subject=? and session=? and operation=? and receipt is null").run(checked, ...values(scope), session, operation);
    },
    record(scope: SyncScope, raw: ConversationTerminalRuntime) {
      const runtime = conversationTerminalRuntimeSchema.parse(raw);
      db.exec("begin immediate");
      try {
        const row = owner(scope), args = values(scope);
        const counts = db.prepare(`select count(*) as items,count(distinct session) as sessions,
          coalesce(sum(length(cast(json_extract(request,'$.command.version.checkpoint') as blob))),0) as bytes,
          min(created_ms) as oldest,count(*) filter(where created_ms is null) as unknown,
          count(*) filter(where attempts>0) as attempted,coalesce(sum(attempts),0) as attempts,max(attempt_ms) as last
          from sync_outbox where tenant=? and subject=? and receipt is null`).get(...args)!;
        const files = db.prepare(`select coalesce(sum(bytes),0) as bytes from (
          select json_extract(f.value,'$.sha256') as hash,max(json_extract(f.value,'$.bytes')) as bytes
          from sync_outbox o,json_each(o.request,'$.command.version.files') f
          where tenant=? and subject=? and receipt is null group by hash)`).get(...args)!;
        const ack = db.prepare("select count(*) as total,max(acknowledged_ms) as last from sync_outbox where tenant=? and subject=? and receipt is not null").get(...args)!;
        const reasons = db.prepare(`with heads as (
          select session,min(sequence) as first,count(*) as items from sync_outbox where tenant=? and subject=? and receipt is null group by session)
          select coalesce(r.code,o.failure) as reason,count(*) as sessions,sum(h.items) as items
          from heads h join sync_outbox o on o.sequence=h.first
          left join sync_rejections r on r.tenant=o.tenant and r.subject=o.subject and r.session=o.session
          where coalesce(r.code,o.failure) is not null group by reason`).all(...args).map(r => ({ reason: conversationTerminalReasonSchema.parse(r.reason), sessions: Number(r.sessions), items: Number(r.items) }));
        const now = Date.now(), peak = Math.max(Number(row.peak), Number(counts.items));
        const phase = runtime.phase === "scanning" && Number(counts.items) > 0 ? "syncing" : runtime.phase === "caught_up" && (Number(counts.items) > 0 || runtime.localReasons.length > 0) ? "blocked" : runtime.phase;
        const recovered = phase === "caught_up" && (peak > 0 || row.last_caught_up_ms === null);
        const lastCaughtUp = recovered ? now : row.last_caught_up_ms;
        const lastRecoveredItems = recovered ? Math.max(0, Number(ack.total) - Number(row.ack_baseline)) : Number(row.last_recovered_items);
        const lastPeak = recovered ? peak : Number(row.last_recovery_peak);
        const sequence = Number(row.sequence) + 1;
        const report = conversationTerminalReportSchema.parse({
          ...runtime, phase, sequence, observedAt: new Date(now).toISOString(),
          queue: { items: Number(counts.items), sessions: Number(counts.sessions), checkpointBytes: Number(counts.bytes), fileBytes: Number(files.bytes),
            oldestPendingAt: iso(counts.oldest), unknownAgeItems: Number(counts.unknown), attemptedItems: Number(counts.attempted), attempts: Number(counts.attempts),
            lastAttemptAt: iso(counts.last), lastAcknowledgedAt: iso(ack.last), acknowledgedItems: Number(ack.total) }, reasons,
          recovery: { lastCaughtUpAt: iso(lastCaughtUp), lastRecoveredItems, lastPendingPeak: lastPeak, pendingPeak: recovered ? 0 : peak },
        });
        db.prepare(`update sync_reporting set sequence=?,peak=?,ack_baseline=?,last_caught_up_ms=?,last_recovered_items=?,last_recovery_peak=?
          where tenant=? and subject=?`).run(sequence, recovered ? 0 : peak, recovered ? Number(ack.total) : Number(row.ack_baseline),
          lastCaughtUp as number | null, lastRecoveredItems, lastPeak, ...args);
        db.exec("commit"); return report;
      } catch (cause) { db.exec("rollback"); throw cause; }
    },
  };
}
