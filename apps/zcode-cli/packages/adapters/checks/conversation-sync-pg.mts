import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { checkConcurrentOutboxUpgrade } from "./sync-outbox-concurrent.mjs";
import {
  ConversationSyncError,
  type SyncCommand,
  type SyncRequest,
  type SyncScope,
} from "@zcode/contracts";
import {
  createConversationSyncStore,
  migrateConversationSync,
} from "@zcode/adapters/conversation-sync";
import { events, logger, version, checkpoint } from "./sync-fixture.mjs";
import { verifyOutbox } from "./sync-outbox.mjs";
import { verifyHttp } from "./sync-http.mjs";
import { verifyDeletionChoice } from "./sync-deletion-choice.mjs";
import { verifyCapacity } from "./sync-capacity.mjs";
import { verifyTransitions } from "./sync-transitions.mjs";
import { verifyManaged } from "./sync-managed.mjs";

const lines: Buffer[] = [];
for await (const chunk of process.stdin) lines.push(Buffer.from(chunk));
const connection = JSON.parse(Buffer.concat(lines).toString());
assert.equal(connection.syntheticOnly, true);
assert.equal(connection.host, "127.0.0.1");
const owner = new pg.Pool({
  host: connection.host,
  port: connection.port,
  user: "postgres",
  password: connection.password,
  database: "postgres",
  max: 1,
});
const password = connection.runtimePassword;
const root = await mkdtemp(join(tmpdir(), "native-sync-proof-"));
const tenant = randomUUID();
const scope = { tenant, subject: randomUUID() };
const other = { tenant, subject: randomUUID() };
const cross = { tenant: randomUUID(), subject: scope.subject };
const report: Record<string, unknown> = {
  syntheticOnly: true,
  deploymentTouched: false,
  checks: [],
};
const checks: string[] = report.checks as string[];
let runtime: pg.Pool | undefined;
try {
  await checkConcurrentOutboxUpgrade();
  checks.push("eight_real_Host_processes_upgrade_one_previous_outbox_without_duplicate_migration");
  await migrateConversationSync(owner);
  await migrateConversationSync(owner);
  // Secret is passed as a parameter through the server function, never command-line or report.
  await owner.query(`select set_config('sync_fixture.password',$1,false)`, [password]);
  await owner.query(
    `do $$ begin execute format('create role sync_fixture login password %L nosuperuser nobypassrls', current_setting('sync_fixture.password')); end $$`,
  );
  await owner.query("grant zcode_sync_runtime to sync_fixture");
  runtime = new pg.Pool({
    host: connection.host,
    port: connection.port,
    user: "sync_fixture",
    password,
    database: "postgres",
    max: 4,
  });
  const options = {
    pool: runtime,
    allowedScopes: [scope, other, cross],
    maxCheckpointBytes: 128_000,
    maxSubjectBytes: 1_000_000,
    maxVersionsPerSession: 100,
    logger,
  };
  const store = createConversationSyncStore(options);
  const first: SyncRequest = {
    session: "session-sync",
    operation: randomUUID(),
    command: { kind: "receive", version: version("base") },
  };
  const duplicates = await Promise.all(
    Array.from({ length: 8 }, () => store.execute(scope, first)),
  );
  assert(duplicates.every((item) => JSON.stringify(item) === JSON.stringify(duplicates[0])));
  assert.equal(duplicates[0].state.revision, 1);
  assert.equal(duplicates[0].state.selected, null);
  assert.equal(duplicates[0].state.active, null);
  await assert.rejects(
    store.execute(scope, { ...first, command: { kind: "receive", version: version("other") } }),
    { code: "conflict" },
  );
  assert.deepEqual(await store.receipt(scope, first.session, first.operation), duplicates[0]);
  checks.push("concurrent_exact_operation_and_lost_ack_no_extra_version");
  // Reproduce the previously shipped native v1 shape with real persisted data.
  await owner.query("alter table zcode_sync.versions drop column management");
  await owner.query("drop table zcode_sync.configuration");
  await owner.query("update zcode_sync.schema_version set version=1");
  await assert.rejects(store.state(scope, "session-sync"), { code: "schema" });
  await migrateConversationSync(owner);
  assert.deepEqual(await store.receipt(scope, first.session, first.operation), duplicates[0]);
  assert.equal((await store.history(scope, null, 10))[0].management, null);
  checks.push("native_v1_to_v3_preserves_existing_versions_receipts_and_unknown_index");
  assert.deepEqual(
    await store.execute(
      { tenant: scope.tenant.toUpperCase(), subject: scope.subject.toUpperCase() },
      first,
    ),
    duplicates[0],
  );

  await runtime.end();
  runtime = new pg.Pool({
    host: connection.host,
    port: connection.port,
    user: "sync_fixture",
    password,
    database: "postgres",
    max: 4,
  });
  const reopened = createConversationSyncStore({ ...options, pool: runtime });
  assert.deepEqual(
    await reopened.version(scope, "session-sync", "base"),
    first.command.kind === "receive" ? first.command.version : null,
  );
  assert.equal((await reopened.receipt(scope, first.session, first.operation))?.state.revision, 1);
  checks.push("new_pool_reads_committed_version_and_receipt");
  for (const isolated of [other, cross]) {
    assert.equal(await reopened.state(isolated, "session-sync"), null);
    assert.equal(await reopened.version(isolated, "session-sync", "base"), null);
    assert.equal(await reopened.receipt(isolated, first.session, first.operation), null);
    assert.deepEqual(await reopened.list(isolated, null, 100), []);
  }
  const raw = await runtime.connect();
  try {
    assert.equal(
      (await raw.query("select count(*)::int as total from zcode_sync.versions")).rows[0].total,
      0,
    );
    await assert.rejects(
      raw.query("update zcode_sync.versions set location='changed'"),
      /permission denied/,
    );
    await assert.rejects(raw.query("delete from zcode_sync.payloads"), /permission denied/);
  } finally {
    raw.release();
  }
  await assert.rejects(
    createConversationSyncStore({ ...options, pool: owner }).state(scope, "session-sync"),
    { code: "scope" },
  );
  await assert.rejects(
    createConversationSyncStore({ ...options, pool: runtime, allowedScopes: [] }).state(
      scope,
      "session-sync",
    ),
    { code: "scope" },
  );
  checks.push("restricted_role_rls_account_tenant_and_default_disabled");
  // Remaining checks use the reopened facade; the original pool is intentionally closed.
  await verifyTransitions(reopened, scope, checks);
  await verifyManaged(owner, runtime, scope, connection, checks);
  await verifyOutbox(reopened, scope, other, root, checks);
  await verifyHttp(reopened, scope, other, checks);
  await verifyDeletionChoice(reopened, scope, checks);
  const limited = createConversationSyncStore({ ...options, pool: runtime, maxCheckpointBytes: 1 });
  const blocked = {
    session: "limited",
    operation: randomUUID(),
    command: {
      kind: "receive" as const,
      version: { ...version("large"), checkpoint: checkpoint("limited") },
    },
  };
  await assert.rejects(limited.execute(scope, blocked), { code: "limit" });
  assert.equal(await reopened.state(scope, "limited"), null);
  assert.equal(await reopened.receipt(scope, "limited", blocked.operation), null);
  checks.push("limit_has_no_partial_version_or_false_watermark");
  assert(!JSON.stringify(events).includes("SYNTHETIC_PRIVATE_PROMPT"));
  checks.push("structured_observation_excludes_body");
  await reopened.execute(other, first);
  const separated = await owner.query(
    `select count(distinct subject)::int as total from zcode_sync.payloads
    where digest=(select digest from zcode_sync.versions where tenant=$1 and subject=$2 and session=$3 and id='base')`,
    [scope.tenant, scope.subject, first.session],
  );
  assert.equal(separated.rows[0].total, 2);
  checks.push("payload_dedup_remains_inside_account_scope");
  await owner.query("update zcode_sync.schema_version set version=99");
  await assert.rejects(migrateConversationSync(owner), { code: "schema" });
  await assert.rejects(reopened.state(scope, first.session), { code: "schema" });
  assert.equal(
    (await owner.query("select version from zcode_sync.schema_version")).rows[0].version,
    99,
  );
  await owner.query("update zcode_sync.schema_version set version=3");
  await owner.query("alter role zcode_sync_runtime bypassrls");
  await assert.rejects(migrateConversationSync(owner), { code: "scope" });
  await owner.query("alter role zcode_sync_runtime nobypassrls");
  checks.push("future_schema_and_privileged_runtime_role_rejected_without_reinitialization");

  const capacityScope = { tenant: scope.tenant, subject: randomUUID() };
  report.capacity = await verifyCapacity({
    repairedStore: createConversationSyncStore({
      ...options,
      pool: runtime,
      allowedScopes: [capacityScope],
      maxCheckpointBytes: 131_072,
      maxSubjectBytes: 8_388_608,
      maxVersionsPerSession: 64,
    }),
    scope: capacityScope,
    root,
    checks,
    store: createConversationSyncStore({
      ...options,
      pool: runtime,
      allowedScopes: [capacityScope],
      maxCheckpointBytes: 65_536,
      maxSubjectBytes: 8_388_608,
      maxVersionsPerSession: 64,
    }),
  });
  report.capacityScope = capacityScope;
  const quotaScope = { tenant: scope.tenant, subject: randomUUID() };
  const quotaRequests = ["quota-one", "quota-two"].map((session) => ({
    session,
    operation: randomUUID(),
    command: {
      kind: "receive" as const,
      version: { ...version("quota-v1"), checkpoint: checkpoint(session) },
    },
  }));
  const quotaBytes = Buffer.byteLength(JSON.stringify(quotaRequests[0].command.version.checkpoint));
  assert.equal(
    quotaBytes,
    Buffer.byteLength(JSON.stringify(quotaRequests[1].command.version.checkpoint)),
  );
  const quotaStore = createConversationSyncStore({
    ...options,
    pool: runtime,
    allowedScopes: [quotaScope],
    maxCheckpointBytes: quotaBytes,
    maxSubjectBytes: quotaBytes,
  });
  const quotaRace = await Promise.allSettled(
    quotaRequests.map((request, index) =>
      quotaStore.execute(
        index === 0
          ? quotaScope
          : {
              tenant: quotaScope.tenant.toUpperCase(),
              subject: quotaScope.subject.toUpperCase(),
            },
        request,
      ),
    ),
  );
  assert.equal(quotaRace.filter((result) => result.status === "fulfilled").length, 1);
  for (const [index, result] of quotaRace.entries()) {
    if (result.status === "rejected") {
      assert.equal(result.reason.code, "limit");
      assert.equal(await quotaStore.state(quotaScope, quotaRequests[index].session), null);
    }
  }
  const quotaUsage = await owner.query(
    "select sum(bytes)::int as bytes,count(*)::int as total from zcode_sync.payloads where tenant=$1 and subject=$2",
    [quotaScope.tenant, quotaScope.subject],
  );
  assert.equal(quotaUsage.rows[0].bytes, quotaBytes);
  assert.equal(quotaUsage.rows[0].total, 1);
  checks.push("concurrent_cross_session_quota_and_UUID_case_use_one_subject_lock_no_partial_loser");

  report.fixtureScope = scope;
  report.eventCount = events.length;
  report.nativeSchemaVersion = (
    await owner.query("select version from zcode_sync.schema_version")
  ).rows[0].version;
  await writeFile(connection.report, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + "\n");
} finally {
  await runtime?.end();
  await owner.end();
  await rm(root, { recursive: true, force: true });
}
