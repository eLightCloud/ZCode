import assert from "node:assert/strict";
import pg from "pg";
import { createConversationSyncStore } from "@zcode/adapters/conversation-sync";
import { conversationCenterPolicySchema } from "@zcode/shared";
import { logger } from "./sync-fixture.mjs";
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const connection = JSON.parse(Buffer.concat(chunks).toString("utf8"));
assert.equal(connection.syntheticOnly, true);
assert.equal(connection.host, "127.0.0.1");
const owner = new pg.Pool({
  host: connection.host,
  port: connection.port,
  user: "postgres",
  password: connection.password,
});
const runtime = new pg.Pool({
  host: connection.host,
  port: connection.port,
  user: "sync_fixture",
  password: connection.runtimePassword,
  database: "sync_restored",
});
try {
  const schema = Number(
    (await runtime.query("select version from zcode_sync.schema_version")).rows[0].version,
  );
  assert.equal(schema, 6);
  const restoredPolicy = (await runtime.query("select policy from zcode_sync.configuration"))
    .rows[0].policy;
  assert.deepEqual(conversationCenterPolicySchema.parse(restoredPolicy), restoredPolicy);
  const store = createConversationSyncStore({
    pool: runtime,
    logger,
    maxCheckpointBytes: 128_000,
    maxSubjectBytes: 1_000_000,
    maxVersionsPerSession: 100,
  });
  assert.equal(
    (await store.state(connection.scope, "session-sync"))!.selected,
    "after-delete-late",
  );
  assert.equal((await store.state(connection.scope, "session-sync"))!.active, null);
  assert.equal(
    (await store.version(connection.scope, "http-session", "http-v1"))!.checkpoint!.session.id,
    "http-session",
  );
  assert.equal((await store.state(connection.scope, "worker-http"))!.revision, 1);
  // 新增并发删除夹具也必须完整恢复；比较源端清单与准确状态，不能只改硬编码数量。
  assert.deepEqual(await store.list(connection.scope, null, 100), connection.sessions);
  const continuation = await store.state(connection.scope, "session-runtime-continuation");
  // 最新接续夹具最后选定离线分支并在 cloud 激活，恢复后须保持该准确位置。
  assert.equal(continuation?.active?.location, "runtime-cloud");
  assert.equal(continuation?.handoff?.phase, "activated");
  assert.equal(
    await store.continuations!.read(connection.scope, "session-runtime-continuation"),
    null,
  );
  const capacity = await store.version(
    connection.capacityScope,
    "capacity-session",
    connection.capacity.lastSavedVersion,
  );
  assert.equal(
    capacity!.checkpoint!.messages.length,
    connection.capacity.localRetainedMessages - 2,
  );
  const repairedCapacity = await store.version(
    connection.capacityScope,
    "capacity-session",
    connection.capacity.repairedVersion,
  );
  assert.equal(
    repairedCapacity!.checkpoint!.messages.length,
    connection.capacity.localRetainedMessages,
  );
  const raw = await runtime.connect();
  try {
    await raw.query("begin");
    await raw.query(
      "select set_config('zcode_sync.tenant',$1,true),set_config('zcode_sync.subject',$2,true)",
      [connection.scope.tenant, connection.scope.subject],
    );
    const counts = await raw.query("select count(*)::int as total from zcode_sync.receipts");
    assert(counts.rows[0].total >= 25);
    await raw.query("rollback");
    assert.equal(
      (await raw.query("select count(*)::int as total from zcode_sync.versions")).rows[0].total,
      0,
    );
    await assert.rejects(raw.query("delete from zcode_sync.receipts"), /permission denied/);
  } finally {
    raw.release();
  }
  process.stdout.write(
    JSON.stringify({
      restored: true,
      schema,
      versionsAndReceipts: true,
      rls: true,
      noExecutionStarted: true,
    }) + "\n",
  );
} finally {
  await runtime.end();
  await owner.end();
}
