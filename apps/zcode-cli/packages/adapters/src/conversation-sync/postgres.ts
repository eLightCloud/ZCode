import {
  ConversationSyncError,
  syncRequestSchema,
  syncScopeSchema,
  syncStateSchema,
  syncReceiptSchema,
  syncVersionSchema,
  type ConversationSyncStore,
  type Logger,
  type SyncScope,
  type SyncState,
  type SyncVersion,
  type SyncRequest,
  type SyncReceipt,
} from "@zcode/contracts";
import type { Pool, PoolClient } from "pg";
import { canonical, digest } from "./canonical.js";
import { initialState, transition, versionFacts, type VersionFacts } from "./transitions.js";

export interface SyncStoreOptions {
  pool: Pool;
  /** Trusted controlled-test configuration. Empty means no admission, never global enablement. */
  allowedScopes: readonly SyncScope[];
  maxCheckpointBytes: number;
  maxSubjectBytes: number;
  maxVersionsPerSession: number;
  logger: Logger;
}
function safePositive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function outcome(kind: SyncRequest["command"]["kind"]): SyncReceipt["outcome"] {
  const values = {
    receive: "saved",
    promote: "promoted",
    select: "selected",
    begin: "requested",
    grant: "granted",
    cancel: "cancelled",
    activate: "activated",
    fence: "fenced",
  } as const;
  return values[kind];
}
async function versionsFor(
  client: PoolClient,
  session: string,
): Promise<Map<string, VersionFacts>> {
  const result = await client.query(
    "select id,parent,location,generation,digest from zcode_sync.versions where session=$1",
    [session],
  );
  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        id: row.id,
        parent: row.parent,
        location: row.location,
        generation: Number(row.generation),
        checkpointDigest: row.digest,
      },
    ]),
  );
}
async function readVersion(
  client: PoolClient,
  session: string,
  id: string,
): Promise<SyncVersion | null> {
  const result = await client.query(
    `select v.id,v.parent,v.location,v.generation,v.digest,p.payload
    from zcode_sync.versions v left join zcode_sync.payloads p using(tenant,subject,digest)
    where v.session=$1 and v.id=$2`,
    [session, id],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.digest !== null && (!row.payload || digest(row.payload) !== row.digest))
    throw new ConversationSyncError("storage");
  return syncVersionSchema.parse({
    id: row.id,
    parent: row.parent,
    location: row.location,
    generation: Number(row.generation),
    checkpoint: row.payload ?? null,
  });
}

export function createConversationSyncStore(options: SyncStoreOptions): ConversationSyncStore {
  for (const value of [
    options.maxCheckpointBytes,
    options.maxSubjectBytes,
    options.maxVersionsPerSession,
  ]) {
    if (!safePositive(value)) throw new ConversationSyncError("invalid");
  }
  const allowed = new Set(
    options.allowedScopes.map((scope) => canonical(syncScopeSchema.parse(scope))),
  );
  async function transaction<T>(
    scope: SyncScope,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const checked = syncScopeSchema.safeParse(scope);
    if (!checked.success || !allowed.has(canonical(checked.data)))
      throw new ConversationSyncError("scope");
    const client = await options.pool.connect();
    try {
      await client.query("begin");
      // 同一连接、事务局部作用域；连接池复用不得继承上一人的 RLS 上下文。
      await client.query(
        "select set_config('zcode_sync.tenant', $1, true), set_config('zcode_sync.subject', $2, true)",
        [checked.data.tenant, checked.data.subject],
      );
      const role = await client.query(`select r.rolsuper, r.rolbypassrls,
        pg_has_role(current_user, c.relowner, 'USAGE') as owns
        from pg_roles r cross join pg_class c join pg_namespace n on n.oid = c.relnamespace
        where r.rolname = current_user and n.nspname = 'zcode_sync' and c.relname = 'sessions'`);
      if (
        role.rows.length !== 1 ||
        role.rows[0].rolsuper ||
        role.rows[0].rolbypassrls ||
        role.rows[0].owns
      ) {
        throw new ConversationSyncError("scope");
      }
      const schema = await client.query("select version from zcode_sync.schema_version");
      if (schema.rows.length !== 1 || schema.rows[0].version !== 1)
        throw new ConversationSyncError("schema");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (cause) {
      await client.query("rollback");
      if (cause instanceof ConversationSyncError) throw cause;
      throw new ConversationSyncError("storage", { cause });
    } finally {
      client.release();
    }
  }
  async function receipt(client: PoolClient, session: string, operation: string) {
    const result = await client.query(
      "select receipt, fingerprint from zcode_sync.receipts where session=$1 and operation=$2",
      [session, operation],
    );
    return result.rows[0] as { receipt: unknown; fingerprint: string } | undefined;
  }
  async function state(client: PoolClient, session: string): Promise<SyncState | null> {
    const result = await client.query("select state from zcode_sync.sessions where session=$1", [
      session,
    ]);
    return result.rows.length ? syncStateSchema.parse(result.rows[0].state) : null;
  }
  async function saveVersion(
    client: PoolClient,
    scope: SyncScope,
    session: string,
    value: SyncVersion,
    versions: Map<string, VersionFacts>,
  ) {
    if (versions.size >= options.maxVersionsPerSession) throw new ConversationSyncError("limit");
    const payload = value.checkpoint;
    const hash = payload ? digest(payload) : null;
    if (payload) {
      if (payload.session.id !== session) throw new ConversationSyncError("invalid");
      const bytes = Buffer.byteLength(canonical(payload));
      if (bytes > options.maxCheckpointBytes) throw new ConversationSyncError("limit");
      // 主体锁覆盖不同 session 的并发配额，不因去重而跨主体探测内容。
      const usage = await client.query(
        "select coalesce(sum(bytes),0)::text as bytes from zcode_sync.payloads",
      );
      const exists = await client.query("select 1 from zcode_sync.payloads where digest=$1", [
        hash,
      ]);
      if (!exists.rows.length && Number(usage.rows[0].bytes) + bytes > options.maxSubjectBytes)
        throw new ConversationSyncError("limit");
      await client.query(
        `insert into zcode_sync.payloads(tenant,subject,digest,payload,bytes)
        values($1,$2,$3,$4,$5) on conflict do nothing`,
        [scope.tenant, scope.subject, hash, payload, bytes],
      );
    }
    await client.query(
      `insert into zcode_sync.versions(tenant,subject,session,id,parent,location,generation,digest)
      values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        scope.tenant,
        scope.subject,
        session,
        value.id,
        value.parent,
        value.location,
        value.generation,
        hash,
      ],
    );
  }
  return {
    async execute(scope, input) {
      const parsed = syncRequestSchema.safeParse(input);
      if (!parsed.success) throw new ConversationSyncError("invalid");
      const request = parsed.data;
      const log = options.logger.child({
        event: "conversation.sync",
        operationId: request.operation,
        sessionId: request.session,
      });
      try {
        const result = await transaction(scope, async (client) => {
          // UUID scope also protects first-session creation and subject quota races.
          await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
            canonical(syncScopeSchema.parse(scope)),
          ]);
          await client.query(
            `insert into zcode_sync.sessions(tenant,subject,session,state)
            values($1,$2,$3,$4) on conflict do nothing`,
            [scope.tenant, scope.subject, request.session, initialState()],
          );
          await client.query(
            "select session from zcode_sync.sessions where session=$1 for update",
            [request.session],
          );
          const previous = await receipt(client, request.session, request.operation);
          const fingerprint = digest(request.command);
          if (previous) {
            if (previous.fingerprint !== fingerprint) throw new ConversationSyncError("conflict");
            return syncReceiptSchema.parse(previous.receipt);
          }
          const current = (await state(client, request.session))!;
          if (request.command.kind === "begin") {
            const used = await client.query(
              "select 1 from zcode_sync.receipts where session=$1 and receipt #>> '{state,handoff,id}'=$2 limit 1",
              [request.session, request.command.handoff],
            );
            if (used.rows.length) throw new ConversationSyncError("conflict");
          }
          const versions = await versionsFor(client, request.session);
          let next: SyncState;
          if (request.command.kind === "receive" && versions.has(request.command.version.id)) {
            if (
              canonical(versions.get(request.command.version.id)) !==
              canonical(versionFacts(request.command.version))
            )
              throw new ConversationSyncError("conflict");
            next = current;
          } else {
            if (request.command.kind === "receive")
              await saveVersion(client, scope, request.session, request.command.version, versions);
            next = transition(current, request.command, versions);
          }
          syncStateSchema.parse(next);
          const result = syncReceiptSchema.parse({
            operation: request.operation,
            session: request.session,
            fingerprint,
            outcome: outcome(request.command.kind),
            state: next,
          });
          await client.query("update zcode_sync.sessions set state=$1 where session=$2", [
            next,
            request.session,
          ]);
          await client.query(
            `insert into zcode_sync.receipts(tenant,subject,session,operation,fingerprint,receipt)
            values($1,$2,$3,$4,$5,$6)`,
            [scope.tenant, scope.subject, request.session, request.operation, fingerprint, result],
          );
          return result;
        });
        log.info("Conversation sync committed", {
          status: "completed",
          outcome: result.outcome,
          revision: result.state.revision,
        });
        return result;
      } catch (error) {
        log.warn("Conversation sync rejected", {
          status: "failed",
          outcome: "rejected",
          code: error instanceof ConversationSyncError ? error.code : "storage",
        });
        throw error;
      }
    },
    state: (scope, session) => transaction(scope, (client) => state(client, session)),
    version: (scope, session, id) =>
      transaction(scope, async (client) => readVersion(client, session, id)),
    receipt: (scope, session, operation) =>
      transaction(scope, async (client) => {
        const result = await receipt(client, session, operation);
        return result ? syncReceiptSchema.parse(result.receipt) : null;
      }),
    list: (scope, after, limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new ConversationSyncError("invalid");
      return transaction(scope, async (client) => {
        const result = await client.query(
          "select session,state from zcode_sync.sessions where ($1::text is null or session > $1) order by session limit $2",
          [after, limit],
        );
        return result.rows.map((row) => ({
          session: row.session as string,
          state: syncStateSchema.parse(row.state),
        }));
      });
    },
  };
}
