import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  createConversationSyncPolicyStore,
  createConversationSyncStore,
  createConversationSyncGateway,
} from "@zcode/adapters/conversation-sync";
import type { SyncScope } from "@zcode/contracts";
import { logger } from "./sync-fixture.mjs";

export async function verifyManaged(
  owner: pg.Pool,
  runtime: pg.Pool,
  scope: SyncScope,
  connection: { host: string; port: number; runtimePassword: string },
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
    assert.equal(first.revision, 0);
    assert.equal(first.policy.enabled, false);
    await assert.rejects(store.state(scope, "session-sync"), { code: "scope" });
    await assert.rejects(runtime.query("update zcode_sync.configuration set revision=1"), {
      code: "42501",
    });
    await assert.rejects(pool.query("select * from zcode_sync.sessions"), { code: "42501" });
    const policy = { ...first.policy, enabled: true, subjects: [scope] };
    const raced = await Promise.allSettled([config.update(0, policy), config.update(0, policy)]);
    assert.equal(raced.filter((value) => value.status === "fulfilled").length, 1);
    assert.equal((await config.read()).revision, 1);
    assert(await store.state(scope, "session-sync"));
    await assert.rejects(store.state({ ...scope, subject: randomUUID() }, "session-sync"), {
      code: "scope",
    });
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
        body: JSON.stringify({ revision: 1, policy: { ...policy, enabled: false } }),
      });
      assert.equal(saved.status, 200);
      await assert.rejects(store.state(scope, "session-sync"), { code: "scope" });
      await config.update(2, policy);
      assert(await store.state(scope, "session-sync"));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    checks.push(
      "managed_native_policy_default_deny_CAS_role_channel_separation_and_live_consumption",
    );
  } finally {
    await pool.end();
  }
}
