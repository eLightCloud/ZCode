import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ConversationSyncStore, SyncScope, ProjectId, SessionId } from "@zcode/contracts";
import {
  createConversationSyncOutbox,
  createConversationSyncWorker,
  createNativeConversationSyncSource,
} from "@zcode/adapters/conversation-sync";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { checkpoint, logger, version } from "./sync-fixture.mjs";

export async function verifyOutbox(
  store: ConversationSyncStore,
  scope: SyncScope,
  other: SyncScope,
  root: string,
  checks: string[],
) {
  const path = join(root, "sync.sqlite");
  let outbox = createConversationSyncOutbox(path);
  const cp = checkpoint("outbox-session");
  const request = {
    session: cp.session.id,
    operation: randomUUID(),
    command: { kind: "receive" as const, version: { ...version("outbox-base"), checkpoint: cp } },
  };
  outbox.stage(scope, request);
  assert.equal(outbox.watermark(scope, cp.session.id), null);
  outbox.close();
  outbox = createConversationSyncOutbox(path);
  assert.deepEqual(outbox.pending(scope), [request]);
  const committed = await store.execute(scope, request);
  // Lost ACK: process restarts without acknowledging. Retry still uses original bytes and key.
  outbox.close();
  outbox = createConversationSyncOutbox(path);
  const receipt = await store.execute(scope, outbox.pending(scope)[0]);
  assert.deepEqual(receipt, committed);
  assert.throws(() => outbox.acknowledge(other, receipt), { code: "conflict" });
  assert.throws(() => outbox.acknowledge(scope, { ...receipt, fingerprint: "0".repeat(64) }), {
    code: "conflict",
  });
  outbox.acknowledge(scope, receipt);
  assert.equal(outbox.pending(scope).length, 0);
  assert.equal(outbox.watermark(other, cp.session.id), null);
  checks.push("sqlite_outbox_reopen_lost_ack_exact_fingerprint_account_partition");
  const source = await createSqliteSessionStore({ dbPath: join(root, "source.sqlite") });
  const target = await createSqliteSessionStore({ dbPath: join(root, "target.sqlite") });
  try {
    await source.importTextCheckpoint!({
      checkpoint: cp,
      target: { projectID: "source" as ProjectId, directory: root },
    });
    const exported = await source.exportTextCheckpoint!({ sessionID: cp.session.id as SessionId });
    assert.deepEqual(JSON.parse(JSON.stringify(exported)), cp);
    const saved = await store.version(scope, cp.session.id, "outbox-base");
    await target.importTextCheckpoint!({
      checkpoint: saved!.checkpoint,
      target: { projectID: "target" as ProjectId, directory: root },
    });
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          await target.exportTextCheckpoint!({ sessionID: cp.session.id as SessionId }),
        ),
      ),
      cp,
    );
  } finally {
    source.close();
    target.close();
  }
  checks.push("native_public_sqlite_export_center_read_target_import_same_id_and_parts");
  let active: SyncScope | null = scope;
  const worker = createConversationSyncWorker({
    scope,
    currentScope: () => active,
    outbox,
    center: store,
    logger,
    source: {
      changes: async (after) => ({
        cursor: after + 1,
        items: [
          {
            workspacePurpose: "directory",
            hasLocalDirectory: true,
            session: "excluded",
            version: version("excluded"),
          },
          {
            workspacePurpose: "unknown",
            hasLocalDirectory: false,
            session: "unknown",
            version: version("unknown"),
          },
          {
            workspacePurpose: "conversation",
            hasLocalDirectory: true,
            session: "rebound",
            version: version("rebound"),
          },
        ],
      }),
    },
  });
  await Promise.all([worker.reconcile(), worker.reconcile()]);
  assert.equal(outbox.cursor(scope), 1);
  for (const name of ["excluded", "unknown", "rebound"])
    assert.equal(await store.state(scope, name), null);
  active = other;
  await assert.rejects(worker.reconcile(), { code: "scope" });
  assert.equal(outbox.cursor(scope), 1);
  assert.equal(outbox.cursor(other), 0);
  assert.throws(() => outbox.capture(scope, 2, 0, [request]), { code: "stale" });
  checks.push("source_scan_qualification_atomic_cursor_singleflight_and_account_switch");
  const scannerStore = await createSqliteSessionStore({
    dbPath: join(root, "scanner-source.sqlite"),
  });
  const scanCheckpoint = checkpoint("scan-session");
  try {
    await scannerStore.importTextCheckpoint!({
      checkpoint: scanCheckpoint,
      target: { projectID: "scan" as ProjectId, directory: root },
    });
    let rebound = false;
    const source = createNativeConversationSyncSource({
      scope,
      store: scannerStore,
      outbox,
      owner: {
        enumerate: async () => [
          {
            session: scanCheckpoint.session.id as SessionId,
            workspacePurpose: "conversation",
            hasLocalDirectory: false,
          },
        ],
        withCheckpointBoundary: async (_session, run) =>
          run({
            workspacePurpose: "conversation",
            hasLocalDirectory: rebound,
            location: "scanner-desktop",
            generation: 0,
            baseline: null,
          }),
        blocked: () => {
          throw new Error("unexpected_native_source_block");
        },
      },
    });
    const scanWorker = createConversationSyncWorker({
      scope,
      source,
      outbox,
      center: store,
      logger,
      currentScope: () => scope,
    });
    await scanWorker.reconcile();
    const firstVersion = outbox.latest(scope, scanCheckpoint.session.id)!;
    await scanWorker.reconcile();
    assert.equal((await store.state(scope, scanCheckpoint.session.id))!.revision, 1);
    await scannerStore.savePart({
      sessionID: scanCheckpoint.session.id as SessionId,
      messageID: "assistant-1" as never,
      id: "part-assistant" as never,
      type: "text",
      text: "Changed after lost notification",
    });
    // Enumeration says conversation, but directory was bound before the owner boundary.
    rebound = true;
    await scanWorker.reconcile();
    assert.equal((await store.state(scope, scanCheckpoint.session.id))!.revision, 1);
    rebound = false;
    await scanWorker.reconcile();
    const next = outbox.latest(scope, scanCheckpoint.session.id)!;
    assert.equal(next.command.kind, "receive");
    if (next.command.kind === "receive" && firstVersion.command.kind === "receive")
      assert.equal(next.command.version.parent, firstVersion.command.version.id);
    assert.equal((await store.state(scope, scanCheckpoint.session.id))!.revision, 2);
    checks.push(
      "native_SQLite_full_rescan_recovers_lost_notification_and_rechecks_directory_under_owner_boundary",
    );
  } finally {
    scannerStore.close();
  }
  outbox.close();
  const foreign = join(root, "plugin-store.sqlite");
  const raw = new DatabaseSync(foreign);
  raw.exec("create table custom_plugin(value text); insert into custom_plugin values('preserved')");
  raw.close();
  assert.throws(() => createConversationSyncOutbox(foreign), { code: "schema" });
  const unchanged = new DatabaseSync(foreign);
  assert.equal(unchanged.prepare("select value from custom_plugin").get()!.value, "preserved");
  unchanged.close();
  checks.push("unrelated_plugin_database_rejected_without_schema_replacement");
}
