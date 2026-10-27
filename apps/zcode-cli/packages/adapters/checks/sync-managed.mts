import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  createConversationSyncPolicyStore,
  createConversationSyncStore,
  createConversationSyncGateway,
  migrateConversationSync,
} from "@zcode/adapters/conversation-sync";
import type { SyncScope } from "@zcode/contracts";
import { logger } from "./sync-fixture.mjs";
import { checkpoint } from "./sync-fixture.mjs";

export async function verifyManaged(
  owner: pg.Pool,
  runtime: pg.Pool,
  scope: SyncScope,
  connection: { host: string; port: number; password: string; runtimePassword: string },
  checks: string[],
) {
  await owner.query("select set_config('sync_fixture.password',$1,false)", [
    connection.runtimePassword,
  ]);
  await owner.query(
    `do $$ begin execute format('create role sync_configuration_fixture login password %L nosuperuser nobypassrls',current_setting('sync_fixture.password')); end $$`,
  );
  await owner.query("grant zcode_sync_configurator to sync_configuration_fixture");
  const pool = new pg.Pool({
    host: connection.host,
    port: connection.port,
    database: "postgres",
    user: "sync_configuration_fixture",
    password: connection.runtimePassword,
  });
  try {
    const config = createConversationSyncPolicyStore({ pool, logger });
    const store = createConversationSyncStore({ pool: runtime, policy: "managed", logger });
    const first = await config.read();
    assert.equal(first.revision, 1);
    assert.deepEqual(Object.keys(first.policy).sort(), [
      "maxCheckpointBytes",
      "maxSubjectBytes",
      "maxVersionsPerSession",
    ]);
    assert(await store.state(scope, "session-sync"));
    await assert.rejects(runtime.query("update zcode_sync.configuration set revision=1"), {
      code: "42501",
    });
    await assert.rejects(pool.query("select * from zcode_sync.sessions"), { code: "42501" });
    const persisted = async () =>
      (
        await owner.query(`select
      (select jsonb_agg(to_jsonb(s)) from zcode_sync.sessions s) as sessions,
      (select jsonb_agg(to_jsonb(v)) from zcode_sync.versions v) as versions,
      (select jsonb_agg(to_jsonb(p)) from zcode_sync.payloads p) as payloads,
      (select jsonb_agg(to_jsonb(r)) from zcode_sync.receipts r) as receipts`)
      ).rows;
    const before = await persisted();
    // 复现旧库关闭及限人开放两种策略；增量升级必须保存限额、正文与原回执。
    for (const enabled of [false, true]) {
      const current = await config.read();
      const legacy = { ...current.policy, maxCheckpointBytes: 128000, enabled, subjects: [scope] };
      await owner.query("update zcode_sync.configuration set policy=$1", [legacy]);
      await owner.query("update zcode_sync.schema_version set version=5");
      await assert.rejects(store.history(scope, null, 10), { code: "schema" });
      const migrators = new pg.Pool({
        host: connection.host,
        port: connection.port,
        database: "postgres",
        user: "postgres",
        password: connection.password,
        max: 3,
      });
      try {
        await Promise.all(Array.from({ length: 3 }, () => migrateConversationSync(migrators)));
      } finally {
        await migrators.end();
      }
      const upgraded = await config.read();
      assert.equal(upgraded.revision, current.revision + 1);
      assert.deepEqual(upgraded.policy, { ...current.policy, maxCheckpointBytes: 128000 });
      await migrateConversationSync(owner);
      assert.deepEqual(await config.read(), upgraded);
      assert.deepEqual(await persisted(), before);
      assert(await store.state(scope, "session-sync"));
      // 新账号无需更改配置即可读空历史，原账号会话仍由 RLS 隔离。
      const newcomer = { ...scope, subject: randomUUID() };
      assert.deepEqual(await store.history(newcomer, null, 10), []);
      assert.equal(await store.state(newcomer, "session-sync"), null);
      assert.equal(await store.version(newcomer, "session-sync", "base"), null);
    }
    const capacity = await config.read();
    for (const newcomer of [
      { ...scope, subject: randomUUID() },
      { tenant: randomUUID(), subject: scope.subject },
    ]) {
      await store.execute(newcomer, {
        session: "new-account",
        operation: randomUUID(),
        command: {
          kind: "receive",
          version: {
            id: "first",
            parent: null,
            location: "synthetic-new-account",
            generation: 0,
            checkpoint: checkpoint("new-account"),
          },
        },
      });
      assert.equal((await store.history(newcomer, null, 10)).length, 1);
      assert.equal(await store.version(scope, "new-account", "first"), null);
      assert.equal(await store.version(newcomer, "session-sync", "base"), null);
    }
    assert.deepEqual(await config.read(), capacity);
    const current = await config.read();
    const policy = { ...current.policy, maxCheckpointBytes: 256000 };
    const raced = await Promise.allSettled([
      config.update(current.revision, policy),
      config.update(current.revision, policy),
    ]);
    assert.equal(raced.filter((value) => value.status === "fulfilled").length, 1);
    const savedRevision = current.revision + 1;
    assert.equal((await config.read()).revision, savedRevision);
    const proof = randomUUID(),
      configurationProof = randomUUID();
    const handler = createConversationSyncGateway({
      store,
      proof,
      maxRequestBytes: 262144,
      logger,
      configuration: { proof: configurationProof, store: config },
    });
    const server = createServer((request, response) => {
      void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      assert.equal(
        (await fetch(base + "/configuration", { headers: { authorization: "Bearer " + proof } }))
          .status,
        401,
      );
      assert.equal(
        (
          await fetch(base + "/history", {
            headers: {
              authorization: "Bearer " + configurationProof,
              "x-zcode-sync-tenant": scope.tenant,
              "x-zcode-sync-subject": scope.subject,
            },
          })
        ).status,
        401,
      );
      const saved = await fetch(base + "/configuration", {
        method: "PUT",
        headers: {
          authorization: "Bearer " + configurationProof,
          "content-type": "application/json",
        },
        body: JSON.stringify({ revision: savedRevision, policy: { ...policy, enabled: false } }),
      });
      assert.equal(saved.status, 400);
      const whitelist = await fetch(base + "/configuration", {
        method: "PUT",
        headers: {
          authorization: "Bearer " + configurationProof,
          "content-type": "application/json",
        },
        body: JSON.stringify({ revision: savedRevision, policy: { ...policy, subjects: [] } }),
      });
      assert.equal(whitelist.status, 400);
      assert.equal((await config.read()).revision, savedRevision);
      const limited = await fetch(base + "/configuration", {
        method: "PUT",
        headers: {
          authorization: "Bearer " + configurationProof,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          revision: savedRevision,
          policy: { ...policy, maxCheckpointBytes: 1 },
        }),
      });
      assert.equal(limited.status, 200);
      await assert.rejects(
        store.execute(scope, {
          session: "policy-limit",
          operation: randomUUID(),
          command: {
            kind: "receive",
            version: {
              id: "limited",
              parent: null,
              location: "synthetic",
              generation: 0,
              checkpoint: checkpoint("policy-limit"),
            },
          },
        }),
        { code: "limit" },
      );
      await config.update(savedRevision + 1, policy);
      assert(await store.state(scope, "session-sync"));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    checks.push(
      "managed_capacity_v5_upgrade_preserves_data_new_accounts_CAS_role_channels_and_live_limits",
    );
  } finally {
    await pool.end();
  }
}
