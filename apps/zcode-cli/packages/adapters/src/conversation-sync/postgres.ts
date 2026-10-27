import {
  ConversationSyncError,
  textCheckpointSchema,
  checkpointEffectReferences,
  syncRequestSchema,
  syncScopeSchema,
  syncStateSchema,
  syncReceiptSchema,
  type ConversationSyncStore,
  type Logger,
  type SyncScope,
  type SyncState,
  type SyncVersion,
  type SyncRequest,
  type SyncReceipt,
  type ConversationObjectBytesPort,
} from "@zcode/contracts";
import type { Pool, PoolClient } from "pg";
import { conversationHistorySchema } from "@zcode/shared";
import type { ConversationCenterPolicy } from "@zcode/shared";
import { SyncDiagnosticError } from "./monitoring.js";
import { readCenterPolicy } from "./policy.js";
import { requireRuntimeScope } from "./runtime-scope.js";
import { continuationJournal, requireDeletionSettled } from "./continuation-journal.js";
import { createConversationFileStore } from "./files.js";
import { canonical, digest } from "./canonical.js";
import { versionsFor, readVersion, assignedGenerations } from "./postgres-versions.js";
import {
  initialState,
  transition,
  transitionContinuationSelection,
  versionFacts,
  type VersionFacts,
} from "./transitions.js";

type InjectedPolicy = ConversationCenterPolicy & { policy?: never };
export type SyncStoreOptions = {
  pool: Pool;
  logger: Logger;
  objects?: ConversationObjectBytesPort;
} & (InjectedPolicy | { policy: "managed" });
type Limits = ConversationCenterPolicy;
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

export function createConversationSyncStore(options: SyncStoreOptions): ConversationSyncStore {
  const injected = options.policy === "managed" ? null : options;
  if (injected) {
    for (const value of [
      injected.maxCheckpointBytes,
      injected.maxSubjectBytes,
      injected.maxVersionsPerSession,
    ])
      if (!safePositive(value)) throw new ConversationSyncError("invalid");
  }
  async function transaction<T>(
    scope: SyncScope,
    work: (client: PoolClient, limits: Limits) => Promise<T>,
  ): Promise<T> {
    const checked = syncScopeSchema.safeParse(scope);
    if (!checked.success) throw new ConversationSyncError("scope");
    const client = await options.pool.connect();
    try {
      await client.query("begin");
      await requireRuntimeScope(client, checked.data);
      let limits: Limits;
      if (injected) limits = injected;
      else {
        const policy = (await readCenterPolicy(client)).policy;
        // 有效账号无需另行开通；当前主体仍由可信入口及本事务的强制 RLS 隔离。
        limits = policy;
      }
      const result = await work(client, limits);
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
    limits: Limits,
  ) {
    if (versions.size >= limits.maxVersionsPerSession) throw new SyncDiagnosticError("limit", "version_limit");
    for (const file of value.files ?? []) {
      const saved = await client.query(
        "select bytes from zcode_sync.file_objects where sha256=$1",
        [file.sha256],
      );
      if (!saved.rowCount || Number(saved.rows[0].bytes) !== file.bytes)
        throw new ConversationSyncError("blocked");
    }
    const payload = value.checkpoint;
    const hash = payload ? digest(payload) : null;
    if (payload) {
      if (payload.session.id !== session) throw new ConversationSyncError("invalid");
      const bytes = Buffer.byteLength(canonical(payload));
      if (bytes > limits.maxCheckpointBytes) throw new SyncDiagnosticError("limit", "checkpoint_limit");
      // 主体锁覆盖不同 session 的并发配额，不因去重而跨主体探测内容。
      const usage = await client.query(
        `select ((select coalesce(sum(bytes),0) from zcode_sync.payloads)+
          (select coalesce(sum(bytes),0) from zcode_sync.file_objects))::text as bytes`,
      );
      const exists = await client.query("select 1 from zcode_sync.payloads where digest=$1", [
        hash,
      ]);
      if (!exists.rows.length && Number(usage.rows[0].bytes) + bytes > limits.maxSubjectBytes)
        throw new SyncDiagnosticError("limit", "subject_capacity");
      await client.query(
        `insert into zcode_sync.payloads(tenant,subject,digest,payload,bytes)
        values($1,$2,$3,$4,$5) on conflict do nothing`,
        [scope.tenant, scope.subject, hash, payload, bytes],
      );
    }
    await client.query(
      `insert into zcode_sync.versions(tenant,subject,session,id,parent,location,generation,digest,management,files)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        scope.tenant,
        scope.subject,
        session,
        value.id,
        value.parent,
        value.location,
        value.generation,
        hash,
        value.management ?? null,
        value.files === undefined ? null : canonical(value.files),
      ],
    );
  }
  async function execute(
    scope: SyncScope,
    input: SyncRequest,
    intentOperation?: string,
  ): Promise<SyncReceipt> {
    const parsed = syncRequestSchema.safeParse(input);
    if (!parsed.success) throw new ConversationSyncError("invalid");
    const request = parsed.data;
    const log = options.logger.child({
      event: "conversation.sync",
      operationId: request.operation,
      sessionId: request.session,
    });
    try {
      const result = await transaction(scope, async (client, limits) => {
        // UUID scope also protects first-session creation and subject quota races.
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          canonical(syncScopeSchema.parse(scope)),
        ]);
        await client.query(
          `insert into zcode_sync.sessions(tenant,subject,session,state)
            values($1,$2,$3,$4) on conflict do nothing`,
          [scope.tenant, scope.subject, request.session, initialState()],
        );
        await client.query("select session from zcode_sync.sessions where session=$1 for update", [
          request.session,
        ]);
        const previous = await receipt(client, request.session, request.operation);
        const fingerprint = digest(request.command);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new ConversationSyncError("conflict");
          return syncReceiptSchema.parse(previous.receipt);
        }
        if (intentOperation) {
          const intent = await client.query(
            "select result_json from zcode_sync.continuations where session=$1 and operation=$2 for update",
            [request.session, intentOperation],
          );
          if (!intent.rowCount) throw new ConversationSyncError("not_found");
          const status = intent.rows[0].result_json?.status;
          if (
            status &&
            !(
              (status === "cancelling" && request.command.kind === "cancel") ||
              (status === "forward_only" && request.command.kind === "activate")
            )
          )
            throw new ConversationSyncError("forward_only");
        }
        const current = (await state(client, request.session))!;
        // 原回执已优先返回；新删除决定须在同一会话锁内拒绝未收口的离线位置与意图。
        if (request.command.kind === "select" && request.command.location === null)
          await requireDeletionSettled(client, request.session);
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
            await saveVersion(
              client,
              scope,
              request.session,
              request.command.version,
              versions,
              limits,
            );
          next =
            intentOperation && request.command.kind === "select"
              ? transitionContinuationSelection(current, request.command, versions)
              : transition(
                  current,
                  request.command,
                  versions,
                  request.command.kind === "grant"
                    ? await assignedGenerations(client, request.session)
                    : undefined,
                );
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
        if (intentOperation && ["grant", "select"].includes(request.command.kind)) {
          await client.query(
            `update zcode_sync.continuations set result_json=$3 where session=$1 and operation=$2`,
            [
              request.session,
              intentOperation,
              {
                session: request.session,
                operation: intentOperation,
                status: "forward_only",
                phase: "granted",
                location: next.pending!.location,
                version: next.pending!.version,
              },
            ],
          );
        }
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
  }
  return {
    effects: (scope, session) =>
      transaction(scope, async (client) => {
        const rows = await client.query(
          "select distinct p.payload from zcode_sync.versions v join zcode_sync.payloads p using(tenant,subject,digest) where v.session=$1",
          [session],
        );
        const effects = new Map<string, import("@zcode/shared").ConversationEffect>();
        for (const row of rows.rows)
          for (const effect of checkpointEffectReferences(
            textCheckpointSchema.parse(row.payload),
          )) {
            const key = canonical([
              effect.server,
              effect.owner,
              effect.operation,
              effect.requestKey,
            ]);
            const previous = effects.get(key);
            if (previous && canonical(previous) !== canonical(effect))
              throw new ConversationSyncError("conflict");
            effects.set(key, effect);
          }
        return [...effects].sort(([a], [b]) => a.localeCompare(b)).map(([, effect]) => effect);
      }),
    files: options.objects
      ? createConversationFileStore(transaction, options.objects, options.logger)
      : undefined,
    continuations: continuationJournal(transaction),
    continuation: (scope, session, operation) =>
      continuationJournal(transaction).read(scope, session, operation),
    execute,
    executeContinuation: (scope, operation, request) => execute(scope, request, operation),
    state: (scope, session) => transaction(scope, (client) => state(client, session)),
    history: (scope, after, limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new ConversationSyncError("invalid");
      return transaction(scope, async (client) => {
        // PostgreSQL projects only metadata; never materialize every full checkpoint
        // just to render the workbench list. Paths are absent from this native codec.
        const result = await client.query(
          `select s.session,s.state,v.id,
          coalesce(v.management->>'titleOverride',p.payload->'session'->>'title','') as title,
          v.management as management
          from zcode_sync.sessions s
          left join zcode_sync.versions v on v.tenant=s.tenant and v.subject=s.subject
            and v.session=s.session and v.id=coalesce(s.state->>'selected',s.state->'candidates'->>0)
          left join zcode_sync.payloads p on p.tenant=v.tenant and p.subject=v.subject and p.digest=v.digest
          where ($1::text is null or s.session>$1) order by s.session limit $2`,
          [after, limit],
        );
        return conversationHistorySchema.parse(
          result.rows.map((row) => ({
            session: row.session,
            version: row.id ?? null,
            title: row.title,
            management: row.management ?? null,
            candidates: row.state.candidates,
            selected: row.state.selected,
            revision: row.state.revision,
          })),
        );
      });
    },
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
