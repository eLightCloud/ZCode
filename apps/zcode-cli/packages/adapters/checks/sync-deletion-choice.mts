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
}
