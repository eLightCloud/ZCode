import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ConversationSyncStore, SyncScope, SessionId } from "@zcode/contracts";
import {
  ConversationRuntimeError,
  type ConversationRuntimePort,
  type ConversationContinuationIntent,
} from "@zcode/shared";
import {
  createConversationContinuation,
  createConversationSyncOutbox,
} from "@zcode/adapters/conversation-sync";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { checkpoint, logger } from "./sync-fixture.mjs";

/** Real PG and separate migrated SQLite roots; runtime admission/restore are never mocked. */
export async function verifyContinuation(
  center: ConversationSyncStore,
  scope: SyncScope,
  root: string,
  checks: string[],
) {
  const session = "session-runtime-continuation",
    management = { titleOverride: null, pinned: false, archived: false, deleted: false };
  const known = new Map<
    string,
    {
      port: ConversationRuntimePort;
      store: Awaited<ReturnType<typeof createSqliteSessionStore>>;
      outbox: ReturnType<typeof createConversationSyncOutbox>;
    }
  >();
  const unavailable = new Set<string>(),
    busy = new Set<string>();
  async function location(name: string) {
    const directory = join(root, name);
    await mkdir(directory);
    const store = await createSqliteSessionStore({ dbPath: join(directory, "sessions.sqlite") });
    const outbox = createConversationSyncOutbox(join(directory, "outbox.sqlite"));
    const target = { directory, projectID: "synthetic" as never };
    const port: ConversationRuntimePort = {
      async control(input) {
        if (input.kind === "capture" && busy.has(name)) throw new ConversationRuntimeError("busy");
        if (input.kind === "activate" || input.kind === "activateOffline") {
          const version = await center.version(scope, session, input.version);
          assert(version);
          outbox.adopt(
            scope,
            version,
            input.generation,
            input.operation,
            input.kind === "activateOffline" ? "offline" : "primary",
          );
        }
        if (input.kind === "cancel" && input.generation)
          outbox.advanceGeneration(scope, session, input.generation);
        const result = await store.controlContinuation(input, target);
        return input.kind === "capture"
          ? { ...result, management, baseVersion: outbox.baseline(scope, session)?.id ?? null }
          : result;
      },
    };
    const value = { port, store, outbox };
    known.set(name, value);
    return value;
  }
  const local = await location("runtime-desktop"),
    cloud = await location("runtime-cloud");
  const copy = checkpoint(session);
  const target = { directory: join(root, "runtime-desktop"), projectID: "synthetic" as never };
  await local.store.importTextCheckpoint({ checkpoint: copy, target });
  await center.execute(scope, {
    session,
    operation: randomUUID(),
    command: {
      kind: "receive",
      version: {
        id: "runtime-base",
        parent: null,
        location: "runtime-desktop",
        generation: 0,
        checkpoint: copy,
        management,
      },
    },
  });
  const directory = {
    async list() {
      return [...known.keys()]
        .filter((value) => !unavailable.has(value))
        .map((location) => ({ location, label: location }));
    },
    async runtime(_scope: SyncScope, name: string) {
      if (unavailable.has(name) || !known.has(name))
        throw new ConversationRuntimeError("unavailable");
      return known.get(name)!.port;
    },
  };
  const orchestrator = () =>
    createConversationContinuation({ store: center, runtimes: directory, logger });
  async function intent(
    kind: ConversationContinuationIntent["kind"],
    target: string,
    version?: string,
  ) {
    const state = await center.state(scope, session);
    assert(state);
    return {
      session,
      operation: randomUUID(),
      kind,
      target,
      version: version ?? state.active?.version ?? state.candidates[0]!,
      revision: state.revision,
      candidates: state.candidates,
    };
  }
  const first = await intent("select", "runtime-desktop", "runtime-base");
  assert.equal((await orchestrator().run(scope, first)).status, "ready");
  assert.equal((await center.state(scope, session))?.active?.generation, 1);
  await local.store.savePart({
    id: "part-assistant",
    sessionID: session,
    messageID: "assistant-1",
    type: "text",
    text: "Synthetic final C",
  } as never);
  const handoff = await intent("handoff", "runtime-cloud");
  const granted = await orchestrator().run(scope, handoff);
  assert.equal(granted.status, "ready");
  assert.equal(
    (await cloud.store.exportTextCheckpoint({ sessionID: session as SessionId })).messages[1]!
      .parts[0]!.type,
    "text",
  );
  assert.equal(
    JSON.stringify(await cloud.store.exportTextCheckpoint({ sessionID: session as SessionId })),
    JSON.stringify(await local.store.exportTextCheckpoint({ sessionID: session as SessionId })),
  );
  await assert.rejects(
    local.store.saveSessionInput({
      id: "late-native-input",
      sessionID: session,
      kind: "prompt",
      delivery: "startNow",
      payload: { text: "must refuse" },
    } as never),
    /admission_closed/,
  );
  assert.deepEqual(await orchestrator().run(scope, handoff), granted);
  assert.equal(
    (await orchestrator().cancel(scope, session, handoff.operation)).status,
    "forward_only",
  );
  checks.push(
    "real_native_SQLite_whole_copy_and_PG_handoff_C_source_fenced_ACK_retry_no_second_grant",
  );
  const reverse = await intent("handoff", "runtime-desktop");
  assert.equal((await orchestrator().run(scope, reverse)).status, "ready");
  assert.equal((await center.state(scope, session))?.active?.location, "runtime-desktop");
  checks.push("reverse_handoff_can_reuse_exact_baseline_created_at_another_location");
  // A genuine saved predecessor belongs to the previous generation before cancellation.
  await local.store.savePart({
    id: "part-assistant",
    sessionID: session,
    messageID: "assistant-1",
    type: "text",
    text: "Synthetic pre-cancel saved predecessor",
  } as never);
  const previous = local.outbox.baseline(scope, session)!;
  const versionBeforeCancel = {
    id: "runtime-before-cancel",
    parent: previous.id,
    location: "runtime-desktop",
    generation: local.outbox.branchGeneration(scope, session),
    checkpoint: await local.store.exportTextCheckpoint({ sessionID: session as SessionId }),
    management,
  };
  const original = {
    session,
    operation: randomUUID(),
    command: { kind: "receive" as const, version: versionBeforeCancel },
  };
  local.outbox.capture(scope, 1, 0, [original]);
  local.outbox.acknowledge(scope, await center.execute(scope, original));
  busy.add("runtime-desktop");
  const waiting = await intent("handoff", "runtime-cloud");
  assert.equal((await orchestrator().run(scope, waiting)).reason, "busy");
  const before = (await center.state(scope, session))!.active!.generation;
  assert.equal(
    (await orchestrator().cancel(scope, session, waiting.operation)).status,
    "cancelled",
  );
  assert.equal((await center.state(scope, session))?.active?.generation, before + 1);
  await local.store.saveSessionInput({
    id: "new-after-cancel",
    sessionID: session,
    kind: "prompt",
    delivery: "startNow",
    payload: { text: "allowed" },
  } as never);
  await local.store.settleSessionInput!({
    id: "new-after-cancel",
    sessionID: session as SessionId,
    status: "cancelled",
  });
  busy.delete("runtime-desktop");
  checks.push(
    "cancel_busy_source_resumes_new_generation_without_capture_or_replacing_accepted_work",
  );
  // Cancellation latches under the same native row lock as selection/grant.
  const cancelled = await intent("handoff", "runtime-cloud");
  await center.continuations!.begin(scope, cancelled);
  assert.equal(
    (await center.continuations!.requestCancel(scope, session, cancelled.operation)).result?.status,
    "cancelling",
  );
  await assert.rejects(
    center.executeContinuation!(scope, cancelled.operation, {
      session,
      operation: randomUUID(),
      command: {
        kind: "begin",
        revision: cancelled.revision,
        handoff: cancelled.operation,
        source: "runtime-desktop",
        generation: before + 1,
        target: "runtime-cloud",
        baseline: cancelled.version,
      },
    }),
    { code: "forward_only" },
  );
  assert.equal(
    (await orchestrator().cancel(scope, session, cancelled.operation)).status,
    "cancelled",
  );
  checks.push("cancellation_latch_atomically_prevents_new_native_grant_or_selection");
  assert.equal(
    (await orchestrator().run(scope, await intent("handoff", "runtime-cloud"))).status,
    "ready",
  );
  assert.equal(
    (await orchestrator().run(scope, await intent("handoff", "runtime-desktop"))).status,
    "ready",
  );
  checks.push(
    "post_cancel_handoff_preserves_legitimate_previous_generation_using_original_assignment_receipts",
  );
  const detached = await location("runtime-offline");
  unavailable.add("runtime-desktop");
  const offline = await intent("offline", "runtime-offline");
  assert.equal((await orchestrator().run(scope, offline)).status, "ready");
  unavailable.delete("runtime-desktop");
  assert.deepEqual(await center.continuations!.offlineLocations(scope, session), [
    "runtime-offline",
  ]);
  const refused = await intent("handoff", "runtime-cloud");
  assert.equal((await orchestrator().run(scope, refused)).status, "waiting");
  assert.equal(
    (await orchestrator().cancel(scope, session, refused.operation)).status,
    "cancelled",
  );
  // No new checkpoint exists, but accepted offline work must still settle before choice.
  busy.add("runtime-offline");
  const choose = await intent("select", "runtime-cloud");
  assert.equal((await orchestrator().run(scope, choose)).reason, "busy");
  assert.equal((await orchestrator().cancel(scope, session, choose.operation)).status, "cancelled");
  await detached.store.saveSessionInput({
    id: "offline-after-choice-cancel",
    sessionID: session,
    kind: "prompt",
    delivery: "startNow",
    payload: { text: "must remain writable" },
  } as never);
  await detached.store.settleSessionInput!({
    id: "offline-after-choice-cancel",
    sessionID: session as SessionId,
    status: "cancelled",
  });
  busy.delete("runtime-offline");
  const changed = await intent("select", "runtime-cloud");
  assert.equal((await orchestrator().run(scope, changed)).status, "stale");
  assert.equal(
    (await orchestrator().cancel(scope, session, changed.operation)).status,
    "cancelled",
  );
  const late = (await center.state(scope, session))!.candidates.at(-1)!;
  assert.equal(
    (await orchestrator().run(scope, await intent("select", "runtime-cloud", late))).status,
    "ready",
  );
  assert.deepEqual(await center.continuations!.offlineLocations(scope, session), []);
  await assert.rejects(
    detached.store.saveSessionInput({
      id: "old-offline-fenced",
      sessionID: session,
      kind: "prompt",
      delivery: "startNow",
      payload: { text: "must refuse" },
    } as never),
    /admission_closed/,
  );
  unavailable.add("runtime-cloud");
  const fencedCopy = await intent("offline", "runtime-offline");
  assert.equal((await orchestrator().run(scope, fencedCopy)).status, "waiting");
  assert.equal(
    (await orchestrator().cancel(scope, session, fencedCopy.operation)).status,
    "cancelled",
  );
  unavailable.delete("runtime-cloud");
  checks.push(
    "offline_ready_without_checkpoint_is_an_owner_choice_settles_it_cancel_restores_it_and_fenced_copy_cannot_reopen",
  );
  for (const value of known.values()) {
    value.store.close();
    value.outbox.close();
  }
}
