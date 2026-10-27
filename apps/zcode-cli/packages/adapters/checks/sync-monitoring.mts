import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import {
  createConversationSyncPolicyStore, createConversationSyncStore,
  createConversationSyncGateway, createConversationSyncMonitor, migrateConversationSync,
} from "@zcode/adapters/conversation-sync";
import { conversationMonitoringSchema, conversationUsagePageSchema } from "@zcode/shared";
import { logger, checkpoint } from "./sync-fixture.mjs";

/** Reconstruct an actual pre-v7 fixture; merely changing the version marker is not a migration test. */
export async function removeMonitoringFixture(owner: pg.Pool) {
  await owner.query("drop function if exists zcode_sync.usage_summary(uuid,uuid,uuid,int,int)");
  await owner.query("drop table if exists zcode_sync.terminals");
  await owner.query(`drop function zcode_sync.capacity_summary(bigint,bigint);
    drop table zcode_sync.observations;
    alter table zcode_sync.configuration drop column monitoring_started_at;`);
  for (const table of ["sessions", "versions", "payloads", "file_objects", "continuations"])
    await owner.query(`drop policy observer_aggregate on zcode_sync.${table}`);
}

export async function verifyMonitoring(owner: pg.Pool, runtime: pg.Pool,
  connection: { host: string; port: number; runtimePassword: string }, checks: string[]) {
  const pool = new pg.Pool({ host: connection.host, port: connection.port, user: "sync_configuration_fixture",
    password: connection.runtimePassword, database: "postgres" });
  const config = createConversationSyncPolicyStore({ pool, logger });
  const original = await config.read();
  const scope = { tenant: randomUUID(), subject: randomUUID() };
  const files = new Map<string, Uint8Array>();
  const monitor = createConversationSyncMonitor({ pool: runtime, logger });
  const store = createConversationSyncStore({ pool: runtime, policy: "managed", logger, objects: {
    put: async (_scope, file, data) => { files.set(file.sha256, data); return { binding: randomUUID(), version: file.sha256 }; },
    read: async (_scope, file) => files.get(file.sha256)!,
  }});
  const proof = randomUUID(), configurationProof = randomUUID();
  const handler = createConversationSyncGateway({ store, proof, configuration: { proof: configurationProof, store: config },
    monitor, logger, maxRequestBytes: 262144 });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { authorization: "Bearer " + proof, "content-type": "application/json",
    "x-zcode-sync-tenant": scope.tenant, "x-zcode-sync-subject": scope.subject,
    "x-zcode-sync-location": "monitor-fixture" };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    await response.arrayBuffer(); return response.status;
  };
  const policy = async (update: Partial<typeof original.policy>) => {
    const current = await config.read(); await config.update(current.revision, { ...original.policy, ...update });
  };
  const version = (id: string, parent: string | null = null) => ({ session: "monitor-fixture", operation: randomUUID(), command: {
    kind: "receive", version: { id, parent, location: "monitor-fixture", generation: 0,
      checkpoint: checkpoint("monitor-fixture"), management: { titleOverride: null, archived: false, deleted: false, pinned: false } },
  }});
  try {
    const originalCounts = (await owner.query("select count(*)::int as n,sum(bytes)::text as bytes from zcode_sync.payloads")).rows;
    await owner.query("drop function zcode_sync.usage_summary(uuid,uuid,uuid,int,int); update zcode_sync.schema_version set version=8");
    await assert.rejects(config.usage({ offset: 0, limit: 20 }), { code: "schema" });
    await migrateConversationSync(owner); await migrateConversationSync(owner);
    assert.deepEqual(await config.read(), original);
    assert.deepEqual((await owner.query("select count(*)::int as n,sum(bytes)::text as bytes from zcode_sync.payloads")).rows, originalCounts);
    checks.push("usage_v8_to_v9_preserves_policy_payloads_and_repeat_migration");
    // v6→v7 never increments policy revision or mutates native state.
    const prior = await config.read();
    const before = await owner.query("select count(*)::int as n,sum(bytes)::text as bytes from zcode_sync.payloads");
    await removeMonitoringFixture(owner);
    await owner.query("update zcode_sync.schema_version set version=6");
    await assert.rejects(config.monitoring(), { code: "schema" });
    await migrateConversationSync(owner);
    assert.deepEqual(await config.read(), prior);
    assert.deepEqual((await owner.query("select count(*)::int as n,sum(bytes)::text as bytes from zcode_sync.payloads")).rows, before.rows);
    checks.push("monitoring_v6_to_v8_preserves_policy_revision_payloads_and_is_explicit");
    for (const query of ["select * from zcode_sync.sessions", "select tenant from zcode_sync.payloads", "select payload from zcode_sync.payloads", "select receipt from zcode_sync.file_objects"])
      await assert.rejects(pool.query(query), { code: "42501" });
    await assert.rejects(runtime.query("select zcode_sync.capacity_summary(1,1)"), { code: "42501" });
    await owner.query("set role zcode_sync_observer");
    await assert.rejects(owner.query("select payload from zcode_sync.payloads"), { code: "42501" });
    await owner.query("reset role");
    assert.equal((await fetch(base + "/monitoring", { headers: { authorization: "Bearer " + proof }})).status, 401);
    assert.equal((await fetch(base + "/monitoring", { method: "PUT", headers: { authorization: "Bearer " + configurationProof }})).status, 404);
    const read = async () => {
      const response = await fetch(base + "/monitoring", { headers: { authorization: "Bearer " + configurationProof }});
      assert.equal(response.status, 200); return conversationMonitoringSchema.parse(await response.json());
    };
    assert.equal((await read()).requests.length, 0);
    assert.equal(await post("/versions", {}), 400);
    assert.equal(await post("/versions", { excessive: "x".repeat(270000) }), 413);
    await policy({ maxCheckpointBytes: 1 });
    assert.equal(await post("/versions", version("one")), 413);
    await policy({ maxSubjectBytes: 1 });
    assert.equal(await post("/versions", version("one")), 413);
    const data = Buffer.from("synthetic-monitor-file"), sha256 = createHash("sha256").update(data).digest("hex");
    const file = { uri: `zcode-artifact://monitor/tool-result-${randomUUID()}`, sha256, bytes: data.length, contentType: "text/plain" };
    assert.equal(await post("/file", { file, dataBase64: data.toString("base64") }), 413);
    await policy({ maxVersionsPerSession: 1 });
    assert.equal(await post("/versions", version("one")), 200);
    assert.equal(await post("/versions", version("two", "one")), 413);
    await policy({});
    assert.equal(await post("/versions", version("two", "one")), 200);
    assert.equal(await post("/file", { file, dataBase64: "YWJj" }), 503);
    assert.equal(await post("/file", { file, dataBase64: data.toString("base64") }), 200);
    assert.equal(await post("/file-read", { file }), 200);
    let result = await read();
    for (let retry = 0; retry < 50 && result.requests.reduce((n, row) => n + row.count, 0) < 11; retry++) {
      await new Promise(resolve => setTimeout(resolve, 20)); result = await read();
    }
    for (const reason of ["invalid", "transport_limit", "checkpoint_limit", "subject_capacity", "version_limit", "integrity"])
      assert(result.requests.some(row => row.reason === reason), reason);
    assert(result.requests.some(row => row.action === "checkpoint" && row.outcome === "succeeded" && row.count === 2));
    assert.equal(result.unrecordedRequests, 0);
    const actual = (await owner.query(`select
      (select count(*)::int from zcode_sync.sessions) as sessions,
      (select coalesce(sum(bytes),0)::text from zcode_sync.payloads) as bytes,
      (select coalesce(sum(bytes),0)::text from zcode_sync.file_objects) as files`)).rows[0];
    assert.equal(result.capacity.sessions, actual.sessions);
    const usage = async (query: string) => {
      const response = await fetch(base + "/usage" + query, { headers: { authorization: "Bearer " + configurationProof }});
      assert.equal(response.status, 200);
      return conversationUsagePageSchema.parse(await response.json());
    };
    assert.equal((await fetch(base + "/usage", { headers: { authorization: "Bearer " + proof }})).status, 401);
    assert.equal((await fetch(base + "/usage?subject=" + scope.subject, { headers: { authorization: "Bearer " + configurationProof }})).status, 400);
    const ownUsage = await usage(`?tenant=${scope.tenant}&subject=${scope.subject}`);
    const nativeOwn = (await owner.query(`select coalesce(sum(bytes),0)::text as bytes from (
      select bytes from zcode_sync.payloads where tenant=$1 and subject=$2 union all
      select bytes from zcode_sync.file_objects where tenant=$1 and subject=$2) u`, [scope.tenant, scope.subject])).rows[0];
    assert.equal(ownUsage.totalBytes, Number(nativeOwn.bytes));
    assert.equal(ownUsage.items[0].key, scope.subject);
    const groupedUsage = await usage("?limit=1");
    assert.equal(groupedUsage.items.length, 1);
    assert.ok(groupedUsage.total > 1);
    const excludedUsage = await usage(`?excludeTenant=${scope.tenant}`);
    const tenantUsage = await usage(`?tenant=${scope.tenant}`);
    assert.equal(excludedUsage.totalBytes + tenantUsage.totalBytes, groupedUsage.totalBytes);
    await assert.rejects(runtime.query("select zcode_sync.usage_summary(null,null,null,0,20)"), { code: "42501" });
    checks.push("usage_metadata_scoped_grouped_paginated_excludes_tenant_and_has_no_runtime_or_body_access");
    assert.equal(result.capacity.checkpointBytes, Number(actual.bytes));
    assert.equal(result.capacity.fileBytes, Number(actual.files));
    assert(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_PROMPT"));
    assert(!JSON.stringify(result).includes(scope.subject));
    checks.push("monitoring_actual_HTTP_limit_fail_repair_counts_and_cross_subject_capacity_projection_without_content");
    await owner.query("grant zcode_sync_observer to sync_configuration_fixture");
    await assert.rejects(config.monitoring(), { code: "scope" });
    await owner.query("revoke zcode_sync_observer from sync_configuration_fixture");
    await owner.query("revoke insert on zcode_sync.observations from zcode_sync_runtime");
    assert.equal(await post("/file-read", { file }), 200);
    for (let retry = 0; retry < 50 && !monitor.collection().unrecordedRequests; retry++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(monitor.collection().unrecordedRequests, 1);
    assert((await read()).unrecordedRequests === 1);
    await owner.query("grant insert on zcode_sync.observations to zcode_sync_runtime");
    assert.equal(await post("/file-read", { file }), 200);
    checks.push("monitoring_observer_escalation_rejected_and_collection_failure_does_not_change_committed_business_result");
  } finally {
    await owner.query("reset role");
    await owner.query("revoke zcode_sync_observer from sync_configuration_fixture");
    await owner.query("grant insert on zcode_sync.observations to zcode_sync_runtime");
    await policy({});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
  }
}
