import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ConversationSyncStore, ProjectId, SessionId } from "@zcode/contracts";
import { textCheckpointSchema } from "@zcode/contracts";
import {
  createConversationSyncOutbox,
  createConversationSyncWorker,
} from "@zcode/adapters/conversation-sync";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { logger, checkpoint } from "./sync-fixture.mjs";

function growingCheckpoint(rounds: number) {
  const base = checkpoint("capacity-session");
  const messages = Array.from({ length: rounds }, (_, index) => {
    const user = structuredClone(base.messages[0]);
    const assistant = structuredClone(base.messages[1]);
    user.info.id = `user-${index}`;
    assistant.info.id = `assistant-${index}`;
    if (assistant.info.role === "assistant") assistant.info.parentID = user.info.id;
    user.parts = [{ id: `user-part-${index}`, type: "text", text: "u".repeat(1024) }];
    assistant.parts = [{ id: `assistant-part-${index}`, type: "text", text: "a".repeat(1024) }];
    return [user, assistant];
  }).flat();
  return textCheckpointSchema.parse({
    ...base,
    messages,
    session: { ...base.session, time: { created: 1, updated: rounds + 1 } },
  });
}
export async function verifyCapacity(options: {
  store: ConversationSyncStore;
  repairedStore: ConversationSyncStore;
  scope: { tenant: string; subject: string };
  root: string;
  checks: string[];
}) {
  const outbox = createConversationSyncOutbox(join(options.root, "capacity-outbox.sqlite"));
  const source = createSqliteSessionStore({ dbPath: join(options.root, "capacity-source.sqlite") });
  const target = createSqliteSessionStore({ dbPath: join(options.root, "capacity-target.sqlite") });
  const measurements: Array<{ rounds: number; bytes: number; durationMs: number }> = [];
  let parent: string | null = null;
  let blocked = false;
  let blockedRounds = 0;
  let local = growingCheckpoint(1);
  try {
    for (let rounds = 1; rounds <= 64; rounds += 1) {
      local = growingCheckpoint(rounds);
      const request = {
        session: local.session.id,
        operation: randomUUID(),
        command: {
          kind: "receive" as const,
          version: {
            id: `capacity-${rounds}`,
            parent,
            location: "desktop",
            generation: 0,
            checkpoint: local,
          },
        },
      };
      outbox.stage(options.scope, request);
      const started = performance.now();
      try {
        const receipt = await options.store.execute(options.scope, request);
        outbox.acknowledge(options.scope, receipt);
        measurements.push({
          rounds,
          bytes: Buffer.byteLength(JSON.stringify(local)),
          durationMs: performance.now() - started,
        });
        parent = request.command.version.id;
      } catch (cause) {
        assert.equal((cause as { code: string }).code, "limit");
        assert(Buffer.byteLength(JSON.stringify(local)) > 65_536);
        blocked = true;
        blockedRounds = rounds;
        assert.equal(
          await options.store.receipt(options.scope, local.session.id, request.operation),
          null,
        );
        break;
      }
    }
    assert(blocked);
    assert(parent);
    assert.equal(outbox.pending(options.scope).length, 1);
    const last = outbox.watermark(options.scope, local.session.id)!;
    assert.equal(last.state.candidates[0], parent);
    assert.equal(last.state.active, null);
    await source.importTextCheckpoint!({
      checkpoint: local,
      target: { projectID: "capacity-source" as ProjectId, directory: options.root },
    });
    const retained = await source.exportTextCheckpoint!({
      sessionID: local.session.id as SessionId,
    });
    assert.equal(retained.messages.length, blockedRounds * 2);
    const accepted = await options.store.version(options.scope, local.session.id, parent);
    assert.equal(accepted!.checkpoint!.messages.length, (blockedRounds - 1) * 2);
    await target.importTextCheckpoint!({
      checkpoint: accepted!.checkpoint,
      target: { projectID: "capacity-target" as ProjectId, directory: options.root },
    });
    assert.equal(
      (await target.exportTextCheckpoint!({ sessionID: local.session.id as SessionId })).messages
        .length,
      (blockedRounds - 1) * 2,
    );
    const pendingOperation = outbox.pending(options.scope)[0].operation;
    const retry = createConversationSyncWorker({
      scope: options.scope,
      currentScope: () => options.scope,
      outbox,
      center: options.repairedStore,
      logger,
      source: { changes: async (after) => ({ cursor: after, items: [] }) },
    });
    await retry.reconcile();
    assert.equal(outbox.pending(options.scope).length, 0);
    assert.equal(outbox.watermark(options.scope, local.session.id)!.operation, pendingOperation);
    const repairedVersion = `capacity-${blockedRounds}`;
    assert.equal(
      (await options.repairedStore.version(options.scope, local.session.id, repairedVersion))!
        .checkpoint!.messages.length,
      local.messages.length,
    );
    options.checks.push(
      "raising_test_limit_reconciles_exact_pending_operation_without_truncation_or_new_version_identity",
    );
    options.checks.push(
      "growing_full_snapshots_hit_explicit_limit_preserve_local_complete_body_old_receipt_and_target_readability",
    );
    return {
      profile: { maxCheckpointBytes: 65_536, maxSubjectBytes: 8_388_608, maxVersions: 64 },
      measurements,
      blockedRounds,
      blockedBytes: Buffer.byteLength(JSON.stringify(local)),
      lastSavedVersion: parent,
      localRetainedMessages: retained.messages.length,
      repairedVersion,
      productionCapacityClaim: false,
    };
  } finally {
    outbox.close();
    source.close();
    target.close();
  }
}
