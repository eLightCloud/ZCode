import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ConversationSyncStore, SyncScope } from "@zcode/contracts";
import { createConversationSyncHttpHandler } from "@zcode/adapters/conversation-sync";
import { logger, checkpoint } from "./sync-fixture.mjs";
export async function verifyDeletionChoice(
  store: ConversationSyncStore,
  scope: SyncScope,
  checks: string[],
) {
  const token = randomUUID(),
    session = "http-session",
    location = "choice-native";
  let state = (await store.state(scope, session))!;
  const execute = async (command: Parameters<ConversationSyncStore["execute"]>[1]["command"]) => {
    const receipt = await store.execute(scope, { session, operation: randomUUID(), command });
    state = receipt.state;
    return receipt;
  };
  await execute({
    kind: "promote",
    revision: state.revision,
    version: "http-v1",
    location,
    otherOwnersSettled: true,
  });
  await execute({
    kind: "activate",
    revision: state.revision,
    location,
    generation: state.pending!.generation,
    version: "http-v1",
    recoveryVerified: true,
  });
  await execute({
    kind: "receive",
    version: {
      id: "http-deleted",
      parent: "http-v1",
      location,
      generation: state.generation,
      checkpoint: null,
    },
  });
  await execute({
    kind: "receive",
    version: {
      id: "http-edited",
      parent: "http-v1",
      location: "offline",
      generation: 0,
      checkpoint: checkpoint(session),
    },
  });
  const handler = createConversationSyncHttpHandler({
    store,
    maxRequestBytes: 4096,
    logger,
    authenticate: async (request) => (request.headers.authorization === token ? scope : null),
    qualify: async () => false,
  });
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/deletion-choice`;
  const post = (body: object) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const input = () => ({
      operation: randomUUID(),
      session,
      version: "http-deleted",
      candidates: [...state.candidates],
      revision: state.revision,
    });
    assert.equal((await post({ ...input(), sourceBarrier: true })).status, 400);
    assert.equal((await post(input())).status, 409); // Cannot revoke an active native owner.
    assert.equal((await store.state(scope, session))!.active?.location, location);
    await execute({
      kind: "fence",
      revision: state.revision,
      location,
      generation: state.active!.generation,
      sourceBarrier: true,
    });
    assert.equal((await post({ ...input(), version: "http-edited" })).status, 409); // No fabricated recovery.
    assert.equal((await post({ ...input(), revision: state.revision - 1 })).status, 409);
    const choice = input();
    const response = await post(choice);
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.outcome, "deleted");
    assert.deepEqual(await (await post(choice)).json(), receipt); // Exact ACK-loss retry precedes stale CAS.
    state = (await store.state(scope, session))!;
    assert.equal(state.selected, "http-deleted");
    assert.equal(state.active, null);
    assert.equal(state.pending, null);
    assert((await store.version(scope, session, "http-edited"))!.checkpoint);
    await execute({
      kind: "receive",
      version: {
        id: "http-edit-late",
        parent: "http-edited",
        location: "offline",
        generation: 0,
        checkpoint: checkpoint(session),
      },
    });
    assert(state.candidates.includes("http-edit-late"));
    assert.equal(state.selected, "http-deleted");
    checks.push(
      "explicit_deletion_choice_HTTP_CAS_ACK_retry_no_forged_recovery_active_owner_guard_and_new_late_successor",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await verifyOfflineDeletion(store, scope, checks);
}

/** Real PG decisions/journal; no browser-supplied runtime evidence or instance provisioning. */
async function verifyOfflineDeletion(
  store: ConversationSyncStore,
  scope: SyncScope,
  checks: string[],
) {
  const session = "delete-known-offline",
    journal = store.continuations!;
  for (const [id, content] of [
    ["edit", checkpoint(session)],
    ["deleted", null],
  ] as const)
    await store.execute(scope, {
      session,
      operation: randomUUID(),
      command: {
        kind: "receive",
        version: {
          id,
          parent: null,
          location: "source",
          generation: 0,
          checkpoint: content,
        },
      },
    });
  const state = (await store.state(scope, session))!;
  const choice = {
    session,
    operation: randomUUID(),
    command: {
      kind: "select" as const,
      revision: state.revision,
      candidates: state.candidates,
      version: "deleted",
      location: null,
      recoveryVerified: false as const,
    },
  };
  const intent = {
    session,
    operation: randomUUID(),
    kind: "offline" as const,
    target: "known-offline",
    version: "edit",
    revision: state.revision,
    candidates: state.candidates,
  };
  await journal.begin(scope, intent);
  await assert.rejects(store.execute(scope, choice), { code: "blocked" });
  await journal.requestCancel(scope, session, intent.operation);
  await assert.rejects(store.execute(scope, choice), { code: "blocked" });
  await journal.finish(scope, {
    session,
    operation: intent.operation,
    status: "cancelled",
    phase: "cancelled",
    location: intent.target,
    version: intent.version,
  });
  const offline = { ...intent, operation: randomUUID() };
  await journal.begin(scope, offline);
  await journal.commitOffline(scope, session, offline.operation);
  await assert.rejects(store.execute(scope, choice), { code: "blocked" });
  await journal.finish(scope, {
    session,
    operation: offline.operation,
    status: "ready",
    phase: "ready",
    location: offline.target,
    version: offline.version,
  });
  assert.deepEqual(await journal.offlineLocations(scope, session), [offline.target]);
  await assert.rejects(store.execute(scope, choice), { code: "blocked" });
  assert.deepEqual(await store.state(scope, session), state); // No new checkpoint, no implicit fencing.
  // The trusted coordinator's later ready record proves settlement; this fixture tests PG authority only.
  const settled = {
    ...intent,
    operation: randomUUID(),
    kind: "select" as const,
    target: "settled-target",
  };
  await journal.begin(scope, settled);
  await journal.finish(scope, {
    session,
    operation: settled.operation,
    status: "ready",
    phase: "ready",
    location: settled.target,
    version: settled.version,
  });
  const deleted = await store.execute(scope, choice);
  assert.equal(deleted.state.selected, "deleted");
  assert.deepEqual(await store.execute(scope, choice), deleted);
  checks.push(
    "deletion_refuses_pending_cancelling_forward_only_and_ready_offline_without_checkpoint_then_exact_ACK_retry",
  );

  // Both writers take the session row lock; a new offline intent and deletion cannot both win.
  for (let attempt = 0; attempt < 4; attempt++) {
    const session = `delete-race-${attempt}`;
    for (const [id, content] of [
      ["edit", checkpoint(session)],
      ["deleted", null],
    ] as const)
      await store.execute(scope, {
        session,
        operation: randomUUID(),
        command: {
          kind: "receive",
          version: { id, parent: null, location: "source", generation: 0, checkpoint: content },
        },
      });
    const state = (await store.state(scope, session))!;
    const results = await Promise.allSettled([
      store.execute(scope, {
        session,
        operation: randomUUID(),
        command: {
          kind: "select",
          revision: state.revision,
          candidates: state.candidates,
          version: "deleted",
          location: null,
          recoveryVerified: false,
        },
      }),
      journal.begin(scope, {
        session,
        operation: randomUUID(),
        kind: "offline",
        target: "race-offline",
        version: "edit",
        revision: state.revision,
        candidates: state.candidates,
      }),
    ]);
    assert.equal(results.filter((value) => value.status === "fulfilled").length, 1);
    const rejected = results.find((value) => value.status === "rejected") as PromiseRejectedResult;
    assert(["blocked", "stale"].includes(rejected.reason.code));
  }
  checks.push("deletion_and_offline_begin_are_atomic_on_the_same_PG_session_lock");
}
