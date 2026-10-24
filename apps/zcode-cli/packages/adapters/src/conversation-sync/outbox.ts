import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  ConversationSyncError,
  syncReceiptSchema,
  syncRequestSchema,
  syncScopeSchema,
  type SyncScope,
  type SyncRequest,
  type SyncReceipt,
} from "@zcode/contracts";
import { canonical, digest } from "./canonical.js";

export interface ConversationSyncOutbox {
  stage(scope: SyncScope, request: SyncRequest): void;
  pending(scope: SyncScope): SyncRequest[];
  latest(scope: SyncScope, session: string): SyncRequest | null;
  acknowledge(scope: SyncScope, receipt: SyncReceipt): void;
  watermark(scope: SyncScope, session: string): SyncReceipt | null;
  /** Cursor and staged versions share one SQLite transaction; caller re-scans after source commit. */
  capture(scope: SyncScope, cursor: number, expectedCursor: number, requests: SyncRequest[]): void;
  cursor(scope: SyncScope): number;
  close(): void;
}
const OUTBOX_APPLICATION_ID = 0x5a435359;
const OUTBOX_SCHEMA_VERSION = 1;

/** Separate native sync metadata file; never opens or migrates a session/plugin database. */
export function createConversationSyncOutbox(path: string): ConversationSyncOutbox {
  const db = new DatabaseSync(path);
  const version = Number(db.prepare("pragma user_version").get()?.user_version);
  const application = Number(db.prepare("pragma application_id").get()?.application_id);
  if (version !== 0 && version !== OUTBOX_SCHEMA_VERSION) {
    db.close();
    throw new ConversationSyncError("schema");
  }
  const tables = db.prepare("select name from sqlite_master where type='table'").all();
  if (
    (version === 0 && (tables.length > 0 || application !== 0)) ||
    (version === OUTBOX_SCHEMA_VERSION && application !== OUTBOX_APPLICATION_ID)
  ) {
    db.close();
    throw new ConversationSyncError("schema");
  }
  db.exec("pragma journal_mode = WAL; pragma synchronous = FULL");
  if (version === 0)
    db.exec(`begin immediate;
    create table sync_outbox(tenant text not null, subject text not null, session text not null,
      operation text not null, fingerprint text not null, request text not null, receipt text,
      sequence integer primary key autoincrement, unique(tenant,subject,session,operation));
    create table sync_cursor(tenant text not null, subject text not null, cursor integer not null,
      primary key(tenant,subject));
    pragma application_id = ${OUTBOX_APPLICATION_ID};
    pragma user_version = ${OUTBOX_SCHEMA_VERSION}; commit;`);
  function scopeValues(scope: SyncScope) {
    const parsed = syncScopeSchema.parse(scope);
    return [parsed.tenant, parsed.subject];
  }
  function stage(scope: SyncScope, input: SyncRequest) {
    const request = syncRequestSchema.parse(input);
    if (request.command.kind !== "receive") throw new ConversationSyncError("invalid");
    const values = [...scopeValues(scope), request.session, request.operation];
    const previous = db
      .prepare(
        "select fingerprint from sync_outbox where tenant=? and subject=? and session=? and operation=?",
      )
      .get(...values);
    const hash = digest(request.command);
    if (previous && previous.fingerprint !== hash) throw new ConversationSyncError("conflict");
    db.prepare(`insert into sync_outbox(tenant,subject,session,operation,fingerprint,request)
      values(?,?,?,?,?,?) on conflict do nothing`).run(...values, hash, canonical(request));
  }
  function cursor(scope: SyncScope) {
    const row = db
      .prepare("select cursor from sync_cursor where tenant=? and subject=?")
      .get(...scopeValues(scope));
    return row ? Number(row.cursor) : 0;
  }
  return {
    stage,
    pending(scope) {
      return db
        .prepare(
          "select request from sync_outbox where tenant=? and subject=? and receipt is null order by sequence",
        )
        .all(...scopeValues(scope))
        .map((row) => syncRequestSchema.parse(JSON.parse(String(row.request))));
    },
    latest(scope, session) {
      const row = db
        .prepare(
          "select request from sync_outbox where tenant=? and subject=? and session=? order by sequence desc limit 1",
        )
        .get(...scopeValues(scope), session);
      return row ? syncRequestSchema.parse(JSON.parse(String(row.request))) : null;
    },
    acknowledge(scope, input) {
      const receipt = syncReceiptSchema.parse(input);
      if (receipt.outcome !== "saved") throw new ConversationSyncError("invalid");
      const values = [...scopeValues(scope), receipt.session, receipt.operation];
      const row = db
        .prepare(
          "select fingerprint,receipt from sync_outbox where tenant=? and subject=? and session=? and operation=?",
        )
        .get(...values);
      if (
        !row ||
        row.fingerprint !== receipt.fingerprint ||
        (row.receipt && row.receipt !== canonical(receipt))
      )
        throw new ConversationSyncError("conflict");
      db.prepare(
        "update sync_outbox set receipt=? where tenant=? and subject=? and session=? and operation=?",
      ).run(canonical(receipt), ...values);
    },
    watermark(scope, session) {
      const row = db
        .prepare(`select receipt from sync_outbox where tenant=? and subject=? and session=?
        and receipt is not null order by sequence desc limit 1`)
        .get(...scopeValues(scope), session);
      return row ? syncReceiptSchema.parse(JSON.parse(String(row.receipt))) : null;
    },
    capture(scope, next, expected, requests) {
      if (
        ![next, expected].every((value) => Number.isSafeInteger(value) && value >= 0) ||
        next < expected
      )
        throw new ConversationSyncError("invalid");
      db.exec("begin immediate");
      try {
        if (cursor(scope) !== expected) throw new ConversationSyncError("stale");
        for (const request of requests) stage(scope, request);
        db.prepare(
          "insert into sync_cursor(tenant,subject,cursor) values(?,?,?) on conflict(tenant,subject) do update set cursor=excluded.cursor",
        ).run(...scopeValues(scope), next);
        db.exec("commit");
      } catch (cause) {
        db.exec("rollback");
        throw cause;
      }
    },
    cursor,
    close: () => db.close(),
  };
}
/** Stable UUID is created once at capture, persisted before the first network attempt. */
export function receiveOperation(
  session: string,
  version: Extract<SyncRequest["command"], { kind: "receive" }>["version"],
): SyncRequest {
  return syncRequestSchema.parse({
    session,
    operation: randomUUID(),
    command: { kind: "receive", version },
  });
}
