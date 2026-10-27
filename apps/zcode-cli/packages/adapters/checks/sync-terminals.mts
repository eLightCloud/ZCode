import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import {
  createConversationSyncOutbox, createConversationSyncPolicyStore, createConversationSyncStore,
  createConversationTerminalStore, createConversationSyncGateway, migrateConversationSync,
} from "@zcode/adapters/conversation-sync";
import { logger } from "./sync-fixture.mjs";

export async function verifyTerminalObservation(owner: pg.Pool, runtime: pg.Pool,
  connection: { host: string; port: number; runtimePassword: string }, checks: string[]) {
  const configuration = new pg.Pool({ host: connection.host, port: connection.port, user: "sync_configuration_fixture", password: connection.runtimePassword, database: "postgres" });
  const policy = createConversationSyncPolicyStore({ pool: configuration, logger });
  const terminals = createConversationTerminalStore({ pool: runtime, logger });
  const first = { tenant: randomUUID(), subject: randomUUID() }, second = { ...first, subject: randomUUID() };
  const box = createConversationSyncOutbox(":memory:"); box.observation.start(first);
  const source = box.location(), proof = randomUUID(), configProof = randomUUID();
  const initial = await policy.read(), prior = await owner.query("select * from zcode_sync.observations order by hour,action,outcome,reason");
  await owner.query("drop function zcode_sync.usage_summary(uuid,uuid,uuid,int,int); drop table zcode_sync.terminals; update zcode_sync.schema_version set version=7");
  await migrateConversationSync(owner); await migrateConversationSync(owner);
  assert.deepEqual(await policy.read(), initial);
  assert.deepEqual((await owner.query("select * from zcode_sync.observations order by hour,action,outcome,reason")).rows, prior.rows);
  checks.push("terminal_v7_to_v8_preserves_policy_observations_business_tables_and_repeat_migration");
  const handler = createConversationSyncGateway({ store: createConversationSyncStore({ pool: runtime, policy: "managed", logger }), proof,
    configuration: { proof: configProof, store: policy }, terminals, logger, maxRequestBytes: 262144 });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { authorization: "Bearer " + proof, "content-type": "application/json", "x-zcode-sync-tenant": first.tenant,
    "x-zcode-sync-subject": first.subject, "x-zcode-sync-location": source, "x-zcode-sync-source-kind": "desktop" };
  const ready = { phase: "caught_up" as const, error: null, consecutiveFailures: 0, nextAttemptAt: null, localReasons: [] };
  const post = (body: unknown, extra = {}) => fetch(url + "/terminal-report", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    const zero = box.observation.record(first, ready);
    assert.equal((await post(zero, { authorization: "Bearer " + configProof })).status, 401);
    assert.equal((await post({ ...zero, tenant: second.tenant })).status, 400);
    assert.equal((await post({ ...zero, localReasons: [{ reason: "secret-provider-message", sessions: 1 }] })).status, 400);
    assert.equal((await post(zero, { "x-zcode-sync-location": "" })).status, 403);
    const queued = { session: "terminal-secret-session", operation: randomUUID(), command: { kind: "receive" as const,
      version: { id: "terminal-version", parent: null, generation: 0, location: source, checkpoint: null } } };
    box.stage(first, queued); box.observation.attempt(first, queued.session, queued.operation); box.observation.failed(first, queued.session, queued.operation, "transport");
    const blocked = box.observation.record(first, { ...ready, phase: "waiting_retry", error: "transport", consecutiveFailures: 1, nextAttemptAt: new Date(Date.now()+1000).toISOString() });
    assert.equal((await post(blocked)).status, 200);
    const view = await policy.monitoring();
    assert.equal(view.terminals.freshPendingItems, 1); assert.equal(view.terminals.freshRetryingSources, 1);
    const ref = view.terminals.sources[0]!.sourceRef;
    assert(!JSON.stringify(view.terminals).includes(first.subject)); assert(!JSON.stringify(view.terminals).includes(source));
    assert(!JSON.stringify(view.terminals).includes(queued.session));
    // Exact replays do not refresh liveness; out-of-order reports never replace this queue.
    const received = (await owner.query("select received_at from zcode_sync.terminals where source=$1", [source])).rows[0].received_at;
    assert.equal((await (await post(blocked)).json()).accepted, true);
    assert.equal((await (await post(zero)).json()).accepted, false);
    assert.deepEqual((await owner.query("select received_at from zcode_sync.terminals where source=$1", [source])).rows[0].received_at, received);
    assert.equal((await policy.monitoring()).terminals.freshPendingItems, 1);
    for (const field of ["tenant", "subject", "source"])
      await assert.rejects(configuration.query(`select ${field} from zcode_sync.terminals`), { code: "42501" });
    await assert.rejects(configuration.query("update zcode_sync.terminals set sequence=99"), { code: "42501" });
    // A different verified person cannot overwrite or read the original source's report.
    assert.equal((await post({ ...zero, sequence: 100 }, { "x-zcode-sync-subject": second.subject })).status, 200);
    assert.equal((await policy.monitoring()).terminals.knownSources, 2);
    await owner.query("update zcode_sync.terminals set received_at=now()-interval '3 minutes' where subject=$1", [first.subject]);
    const stale = (await policy.monitoring()).terminals;
    assert.equal(stale.staleSources, 1); assert.equal(stale.stalePendingItems, 1); assert.equal(stale.freshPendingItems, 0);
    checks.push("terminal_HTTP_source_scope_strict_report_column_permissions_exact_replay_stale_freshness_and_no_PII");
    // Recovery and legacy metadata remain observations, never a business ACK or an execution grant.
    const raw = await runtime.connect();
    try {
      await raw.query("begin"); await raw.query("select set_config('zcode_sync.tenant',$1,true),set_config('zcode_sync.subject',$2,true)", [first.tenant, first.subject]);
      assert.equal((await raw.query("select count(*)::int as n from zcode_sync.terminals")).rows[0].n, 1);
      await raw.query("rollback");
    } finally { raw.release(); }
    const report = box.observation.record(first, { ...ready, phase: "blocked", localReasons: [{ reason: "unsupported", sessions: 1 }] });
    assert.equal((await post(report)).status, 200);
    assert.equal((await policy.monitoring()).terminals.sources.find(value => value.sourceRef === ref)!.fresh, true);
    assert.equal((await policy.monitoring()).terminals.freshBlockedSources, 1);
    const noBusiness = await createConversationSyncStore({ pool: runtime, policy: "managed", logger }).state(first, queued.session);
    assert.equal(noBusiness, null);
    checks.push("terminal_fresh_report_after_outage_preserves_unacknowledged_backlog_and_never_grants_business_state");
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    box.close(); await configuration.end();
  }
}
