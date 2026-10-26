import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
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
import { verifyContinuation } from "./sync-continuation.mjs";

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
  await owner.query("alter table zcode_sync.versions drop column files");
  await owner.query("drop table zcode_sync.file_objects");
  await owner.query("drop table zcode_sync.continuations");
  await owner.query("update zcode_sync.schema_version set version=1");
  await assert.rejects(store.state(scope, "session-sync"), { code: "schema" });
  await migrateConversationSync(owner);
  assert.deepEqual(await store.receipt(scope, first.session, first.operation), duplicates[0]);
  assert.equal((await store.history(scope, null, 10))[0].management, null);
  checks.push("native_v1_to_v5_preserves_existing_versions_receipts_and_unknown_index");
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
  await verifyContinuation(reopened, scope, root, checks);
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
  await owner.query("update zcode_sync.schema_version set version=5");
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

  // Real PG quota/rollback races. Byte-port faults are controlled; SDK/MinIO are verified separately.
  const fileScope = { tenant, subject: randomUUID() };
  const fixed = new Map<
    string,
    { bytes: Uint8Array; receipt: { binding: string; version: string } }
  >();
  let uploads = 0,
    failRead = false,
    failPut = false,
    failCommit = false;
  const objects = {
    async put(_scope: SyncScope, file: { sha256: string }, bytes: Uint8Array) {
      if (!fixed.has(file.sha256)) {
        uploads++;
        fixed.set(file.sha256, {
          bytes,
          receipt: { binding: randomUUID(), version: String(uploads) },
        });
      }
      if (failPut) {
        failPut = false;
        throw new Error("synthetic_upload_ACK_lost");
      }
      return fixed.get(file.sha256)!.receipt;
    },
    async read(_scope: SyncScope, file: { sha256: string }) {
      if (failRead) {
        failRead = false;
        throw new Error("synthetic_read_failure");
      }
      return fixed.get(file.sha256)!.bytes;
    },
  };
  const faultPool = new Proxy(runtime!, {
    get(target, property, receiver) {
      if (property !== "connect") return Reflect.get(target, property, receiver);
      return async () => {
        let fileWrite = false;
        return new Proxy(await target.connect(), {
          get(client, property, receiver) {
            if (property !== "query") return Reflect.get(client, property, receiver);
            return async (...args: unknown[]) => {
              if (
                typeof args[0] === "string" &&
                args[0].startsWith("insert into zcode_sync.file_objects")
              )
                fileWrite = true;
              if (args[0] === "commit" && fileWrite && failCommit) {
                failCommit = false;
                throw new Error("synthetic_before_commit_failure");
              }
              return Reflect.apply(client.query, client, args);
            };
          },
        });
      };
    },
  });
  const fileStore = createConversationSyncStore({
    ...options,
    pool: faultPool,
    allowedScopes: [fileScope],
    maxSubjectBytes: 8,
    objects,
  });
  const file = (bytes: Uint8Array) => ({
    uri: `zcode-artifact://quota/tool-result-${randomUUID()}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    contentType: "text/plain",
  });
  const one = Buffer.from("file-one"),
    two = Buffer.from("file-two"),
    descriptor = file(one);
  for (const phase of ["put", "read", "commit"]) {
    failPut = phase === "put";
    failRead = phase === "read";
    failCommit = phase === "commit";
    await assert.rejects(fileStore.files!.put(fileScope, descriptor, one));
    assert.equal(
      (
        await owner.query(
          "select count(*)::int as n from zcode_sync.file_objects where tenant=$1 and subject=$2",
          [fileScope.tenant, fileScope.subject],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(uploads, 1);
  }
  await fileStore.files!.put(fileScope, descriptor, one);
  const receipt = (
    await owner.query(
      "select receipt from zcode_sync.file_objects where tenant=$1 and subject=$2",
      [fileScope.tenant, fileScope.subject],
    )
  ).rows[0].receipt;
  assert.deepEqual(receipt, fixed.get(descriptor.sha256)!.receipt);
  for (let retry = 0; retry < 3; retry++)
    await assert.rejects(fileStore.files!.put(fileScope, file(two), two), { code: "limit" });
  await Promise.all(
    Array.from({ length: 4 }, () => fileStore.files!.put(fileScope, descriptor, one)),
  );
  assert.equal(uploads, 1);
  checks.push(
    "file_quota_before_IO_lost_upload_ACK_read_and_commit_failure_preserve_exact_retry_no_extra_versions",
  );
  const raceScope = { tenant, subject: randomUUID() };
  const raceStore = createConversationSyncStore({
    ...options,
    pool: runtime,
    allowedScopes: [raceScope],
    maxSubjectBytes: 8,
    objects: {
      ...objects,
      put: async (_scope, file, bytes) => {
        uploads++;
        return { binding: randomUUID(), version: Buffer.from(bytes).toString("hex") };
      },
      read: async (_scope, _file, receipt) => Buffer.from(receipt.version, "hex"),
    },
  });
  const beforeRace = uploads;
  const fileRace = await Promise.allSettled(
    [one, two].map((bytes) => raceStore.files!.put(raceScope, file(bytes), bytes)),
  );
  assert.equal(fileRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(uploads - beforeRace, 1);
  checks.push("concurrent_file_quota_has_one_PG_winner_and_only_one_external_upload");

  report.fixtureScope = scope;
  report.fixtureSessions = await reopened.list(scope, null, 100);
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
