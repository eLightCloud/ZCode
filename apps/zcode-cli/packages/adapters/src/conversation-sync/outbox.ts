import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { outboxControlIdentity } from "./outbox-control-identity.js";
import type { NativeControlIdentityView } from "./contract.js";
import {
  ConversationSyncError,
  syncReceiptSchema,
  syncRequestSchema,
  syncScopeSchema,
  syncVersionSchema,
  type SyncVersion,
  type SyncScope,
  type SyncRequest,
  type SyncReceipt,
} from "@zcode/contracts";
import { canonical, digest } from "./canonical.js";

export interface ConversationSyncOutbox {
  location(): string;
  controlIdentity(enroll?: boolean): NativeControlIdentityView;
  signControlChallenge(nonce: string): string;
  bindInput(scope: SyncScope, command: string, session: string | null): void;
  ownsSession(scope: SyncScope, session: string, command?: string): boolean;
  stage(scope: SyncScope, request: SyncRequest): void;
  pending(scope: SyncScope): SyncRequest[];
  latest(scope: SyncScope, session: string): SyncRequest | null;
  knownSessions(scope: SyncScope): string[];
  baseline(scope: SyncScope, session: string): SyncVersion | null;
  branchGeneration(scope: SyncScope, session: string): number;
  advanceGeneration(scope: SyncScope, session: string, generation: number): void;
  /** Exact verified selected version, not a fabricated upload acknowledgement. */
  adopt(
    scope: SyncScope,
    version: SyncVersion,
    generation: number,
    operation: string,
    mode?: "primary" | "offline",
  ): void;
  branchMode(scope: SyncScope, session: string): "primary" | "offline";
  acknowledge(scope: SyncScope, receipt: SyncReceipt): void;
  watermark(scope: SyncScope, session: string): SyncReceipt | null;
  /** Cursor and staged versions share one SQLite transaction; caller re-scans after source commit. */
  capture(scope: SyncScope, cursor: number, expectedCursor: number, requests: SyncRequest[]): void;
  cursor(scope: SyncScope): number;
  close(): void;
}
const OUTBOX_APPLICATION_ID = 0x5a435359;
const OUTBOX_SCHEMA_VERSION = 5;
const OUTBOX_BUSY_TIMEOUT_MS = 5000;

/** Separate native sync metadata file; never opens or migrates a session/plugin database. */
export function createConversationSyncOutbox(path: string): ConversationSyncOutbox {
  const db = new DatabaseSync(path);
  function ownedVersion() {
    const version = Number(db.prepare("pragma user_version").get()?.user_version);
    const application = Number(db.prepare("pragma application_id").get()?.application_id);
    const tables = db.prepare("select name from sqlite_master where type='table'").all();
    if (
      ![0, 1, 2, 3, 4, OUTBOX_SCHEMA_VERSION].includes(version) ||
      (version === 0 && (tables.length > 0 || application !== 0)) ||
      (version > 0 && application !== OUTBOX_APPLICATION_ID)
    )
      throw new ConversationSyncError("schema");
    return version;
  }
  try {
    db.exec(`pragma busy_timeout=${OUTBOX_BUSY_TIMEOUT_MS}`);
    ownedVersion();
    if (path !== ":memory:") chmodSync(path, 0o600);
    // 首次多 Host 打开时切换 journal_mode 需要额外独占锁，可能与另一个迁移写锁互等。
    // 迁移保留原 journal 模式；FULL + 原子事务满足 outbox 持久性，无需在每次打开时改 WAL。
    db.exec("pragma synchronous = FULL");
    db.exec("begin immediate");
    // 多窗口必须在同一写锁内重读版本；不能各自依据锁前的 v1 再次建表。
    const version = ownedVersion();
    if (version === 0)
      db.exec(`
    create table sync_outbox(tenant text not null, subject text not null, session text not null,
      operation text not null, fingerprint text not null, request text not null, receipt text,
      sequence integer primary key autoincrement, unique(tenant,subject,session,operation));
    create table sync_cursor(tenant text not null, subject text not null, cursor integer not null,
      primary key(tenant,subject));
    pragma application_id = ${OUTBOX_APPLICATION_ID};
    pragma user_version = 1;`);
    if (version < 2) {
      db.exec(`
      create table sync_installation(singleton integer primary key check(singleton=1), location text not null);
      pragma user_version = 2;`);
    }
    if (version < 3)
      db.exec(`
    create table sync_input_owners(command text primary key,tenant text not null,subject text not null,session text);
    create table sync_session_owners(session text primary key,tenant text not null,subject text not null);
    pragma user_version = 3;`);
    if (version < 4)
      db.exec(`create table sync_bases(tenant text not null,subject text not null,session text not null,
      version text not null,generation integer not null,after_sequence integer not null,operation text not null,mode text not null,primary key(tenant,subject,session));
      pragma user_version=4;`);
    if (version < 5)
      db.exec(`create table sync_control_identity(singleton integer primary key check(singleton=1), private_key text not null);
      pragma user_version=5;`);
    db.prepare(
      "insert into sync_installation(singleton,location) values(1,?) on conflict do nothing",
    ).run("host:" + randomUUID());
    db.exec("commit");
  } catch (cause) {
    if (db.isTransaction) db.exec("rollback");
    db.close();
    throw cause;
  }
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
    controlIdentity: (enroll) => outboxControlIdentity(db).prepare(enroll),
    signControlChallenge: (nonce) => outboxControlIdentity(db).sign(nonce),
    location: () =>
      String(
        db.prepare("select location from sync_installation where singleton=1").get()!.location,
      ),
    bindInput(scope, command, session) {
      if (!/^[a-zA-Z0-9_.:-]{1,256}$/.test(command)) throw new ConversationSyncError("invalid");
      const [tenant, subject] = scopeValues(scope);
      db.prepare("insert into sync_input_owners values(?,?,?,?) on conflict do nothing").run(
        command,
        tenant!,
        subject!,
        session,
      );
      const row = db.prepare("select * from sync_input_owners where command=?").get(command)!;
      if (
        row.tenant !== tenant ||
        row.subject !== subject ||
        (row.session !== null && session !== null && row.session !== session)
      )
        throw new ConversationSyncError("scope");
      if (row.session === null && session !== null)
        db.prepare(
          "update sync_input_owners set session=? where command=? and session is null",
        ).run(session, command);
      if (
        session !== null &&
        db.prepare("select session from sync_input_owners where command=?").get(command)
          ?.session !== session
      )
        throw new ConversationSyncError("scope");
    },
    ownsSession(scope, session, command) {
      const [tenant, subject] = scopeValues(scope);
      const row = db.prepare("select * from sync_session_owners where session=?").get(session);
      if (row) return row.tenant === tenant && row.subject === subject;
      if (!command) return false;
      const input = db.prepare("select * from sync_input_owners where command=?").get(command);
      if (
        !input ||
        input.tenant !== tenant ||
        input.subject !== subject ||
        (input.session !== null && input.session !== session)
      )
        return false;
      db.prepare("insert into sync_session_owners values(?,?,?) on conflict do nothing").run(
        session,
        tenant!,
        subject!,
      );
      const saved = db.prepare("select * from sync_session_owners where session=?").get(session)!;
      return saved.tenant === tenant && saved.subject === subject;
    },
    stage,
    knownSessions(scope) {
      return db
        .prepare(
          "select session from sync_outbox where tenant=? and subject=? union select session from sync_bases where tenant=? and subject=? order by session",
        )
        .all(...scopeValues(scope), ...scopeValues(scope))
        .map((row) => String(row.session));
    },
    baseline(scope, session) {
      const values = [...scopeValues(scope), session];
      const anchor = db
        .prepare(
          "select version,after_sequence from sync_bases where tenant=? and subject=? and session=?",
        )
        .get(...values);
      const local = db
        .prepare(
          "select request from sync_outbox where tenant=? and subject=? and session=? and sequence>? order by sequence desc limit 1",
        )
        .get(...values, Number(anchor?.after_sequence ?? 0));
      if (local) {
        const request = syncRequestSchema.parse(JSON.parse(String(local.request)));
        if (request.command.kind !== "receive") throw new ConversationSyncError("invalid");
        return request.command.version;
      }
      return anchor ? syncVersionSchema.parse(JSON.parse(String(anchor.version))) : null;
    },
    branchGeneration(scope, session) {
      return Number(
        db
          .prepare("select generation from sync_bases where tenant=? and subject=? and session=?")
          .get(...scopeValues(scope), session)?.generation ?? 0,
      );
    },
    advanceGeneration(scope, session, generation) {
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new ConversationSyncError("invalid");
      const row = db
        .prepare("select generation from sync_bases where tenant=? and subject=? and session=?")
        .get(...scopeValues(scope), session);
      if (!row || Number(row.generation) > generation) throw new ConversationSyncError("stale");
      const updated = db
        .prepare(
          "update sync_bases set generation=? where tenant=? and subject=? and session=? and generation<=?",
        )
        .run(generation, ...scopeValues(scope), session, generation);
      if (updated.changes !== 1) throw new ConversationSyncError("stale");
    },
    branchMode(scope, session) {
      const mode = db
        .prepare("select mode from sync_bases where tenant=? and subject=? and session=?")
        .get(...scopeValues(scope), session)?.mode;
      return mode === "offline" ? "offline" : "primary";
    },
    adopt(scope, raw, generation, operation, mode = "primary") {
      const version = syncVersionSchema.parse(raw),
        session = version.checkpoint?.session.id;
      if (
        !session ||
        !syncRequestSchema.shape.operation.safeParse(operation).success ||
        !Number.isSafeInteger(generation) ||
        (mode === "primary" ? generation < 1 : generation !== 0)
      )
        throw new ConversationSyncError("invalid");
      const values = [...scopeValues(scope), session];
      db.exec("begin immediate");
      try {
        if (
          db
            .prepare(
              "select 1 from sync_outbox where tenant=? and subject=? and session=? and receipt is null",
            )
            .get(...values)
        )
          throw new ConversationSyncError("blocked");
        const owner = db
          .prepare("select tenant,subject from sync_session_owners where session=?")
          .get(session);
        if (owner && (owner.tenant !== values[0] || owner.subject !== values[1]))
          throw new ConversationSyncError("scope");
        const previous = db
          .prepare(
            "select generation,version,operation,mode from sync_bases where tenant=? and subject=? and session=?",
          )
          .get(...values);
        if (previous?.operation === operation) {
          if (
            previous.version !== canonical(version) ||
            Number(previous.generation) !== generation ||
            previous.mode !== mode
          )
            throw new ConversationSyncError("conflict");
          db.exec("commit");
          return;
        }
        if (
          previous &&
          mode === "primary" &&
          previous.mode === "primary" &&
          Number(previous.generation) >= generation
        )
          throw new ConversationSyncError("stale");
        const sequence = Number(
          db
            .prepare(
              "select coalesce(max(sequence),0) as value from sync_outbox where tenant=? and subject=? and session=?",
            )
            .get(...values)!.value,
        );
        db.prepare(
          "insert into sync_bases values(?,?,?,?,?,?,?,?) on conflict(tenant,subject,session) do update set version=excluded.version,generation=excluded.generation,after_sequence=excluded.after_sequence,operation=excluded.operation,mode=excluded.mode",
        ).run(...values, canonical(version), generation, sequence, operation, mode);
        db.prepare(
          "insert into sync_session_owners(session,tenant,subject) values(?,?,?) on conflict do nothing",
        ).run(session, ...scopeValues(scope));
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
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
