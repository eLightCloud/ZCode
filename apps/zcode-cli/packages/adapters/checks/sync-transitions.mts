import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ConversationSyncStore, SyncCommand, SyncScope, SyncState } from "@zcode/contracts";
import { version } from "./sync-fixture.mjs";

export async function verifyTransitions(
  store: ConversationSyncStore,
  scope: SyncScope,
  checks: string[],
) {
  const session = "session-sync";
  const send = (command: SyncCommand, operation = randomUUID()) =>
    store.execute(scope, { session, operation, command });
  const state = async () => (await store.state(scope, session))!;
  let current = await state();
  current = (
    await send({
      kind: "promote",
      revision: current.revision,
      version: "base",
      location: "desktop",
      otherOwnersSettled: true,
    })
  ).state;
  assert.equal(current.active, null);
  current = (
    await send({
      kind: "activate",
      revision: current.revision,
      ...current.pending!,
      recoveryVerified: true,
    })
  ).state;
  const sourceGeneration = current.active!.generation;
  current = (
    await send({
      kind: "begin",
      revision: current.revision,
      handoff: "h-one",
      source: "desktop",
      target: "cloud",
      baseline: "base",
      generation: sourceGeneration,
    })
  ).state;
  await send({ kind: "receive", version: version("closed", "base", "desktop", sourceGeneration) });
  current = await state();
  current = (
    await send({
      kind: "grant",
      revision: current.revision,
      handoff: "h-one",
      checkpoint: "closed",
      sourceBarrier: true,
      dependenciesVerified: true,
    })
  ).state;
  assert.equal(current.selected, "closed");
  assert.equal(current.active, null);
  assert.equal(current.pending?.location, "cloud");
  await assert.rejects(send({ kind: "cancel", handoff: "h-one" }), { code: "forward_only" });
  await assert.rejects(
    send({
      kind: "activate",
      revision: current.revision,
      location: "desktop",
      generation: sourceGeneration,
      version: "closed",
      recoveryVerified: true,
    }),
    { code: "stale" },
  );
  current = (
    await send({
      kind: "activate",
      revision: current.revision,
      ...current.pending!,
      recoveryVerified: true,
    })
  ).state;
  checks.push("handoff_B_to_C_same_source_grant_then_forward_only_activation");
  // Safe reverse transfer reuses B when no new work exists; B may originate at another location.
  current = (
    await send({
      kind: "begin",
      revision: current.revision,
      handoff: "h-back",
      source: "cloud",
      target: "desktop",
      baseline: "closed",
      generation: current.active!.generation,
    })
  ).state;
  current = (
    await send({
      kind: "grant",
      revision: current.revision,
      handoff: "h-back",
      checkpoint: "closed",
      sourceBarrier: true,
      dependenciesVerified: true,
    })
  ).state;
  current = (
    await send({
      kind: "activate",
      revision: current.revision,
      ...current.pending!,
      recoveryVerified: true,
    })
  ).state;
  checks.push("reverse_handoff_without_new_turn_reuses_B");
  current = (
    await send({
      kind: "begin",
      revision: current.revision,
      handoff: "h-cancel",
      source: "desktop",
      target: "cloud",
      baseline: "closed",
      generation: current.active!.generation,
    })
  ).state;
  const cancelRequest = {
    session,
    operation: randomUUID(),
    command: { kind: "cancel" as const, handoff: "h-cancel" },
  };
  const grantRequest = {
    session,
    operation: randomUUID(),
    command: {
      kind: "grant" as const,
      revision: current.revision,
      handoff: "h-cancel",
      checkpoint: "closed",
      sourceBarrier: true as const,
      dependenciesVerified: true as const,
    },
  };
  const race = await Promise.allSettled([
    store.execute(scope, cancelRequest),
    store.execute(scope, grantRequest),
  ]);
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
  current = await state();
  if (current.handoff!.phase === "granted") {
    await assert.rejects(store.execute(scope, cancelRequest), { code: "forward_only" });
    current = (
      await send({
        kind: "activate",
        revision: current.revision,
        ...current.pending!,
        recoveryVerified: true,
      })
    ).state;
  } else {
    assert.equal(current.handoff!.phase, "cancelled");
    assert.deepEqual(
      await store.execute(scope, cancelRequest),
      (race[0] as PromiseFulfilledResult<unknown>).value,
    );
    await assert.rejects(store.execute(scope, grantRequest), { code: "stale" });
  }
  checks.push("cancel_grant_serialized_one_winner_exact_retry");
  await assert.rejects(
    send({
      kind: "begin",
      revision: current.revision,
      handoff: "h-one",
      source: current.active!.location,
      target: current.active!.location === "cloud" ? "desktop" : "cloud",
      baseline: current.selected!,
      generation: current.active!.generation,
    }),
    { code: "conflict" },
  );
  checks.push("historical_handoff_identity_cannot_be_recreated_after_other_operations");

  const binding = current.active!;
  current = (
    await send({
      kind: "fence",
      revision: current.revision,
      location: binding.location,
      generation: binding.generation,
      sourceBarrier: true,
    })
  ).state;
  await send({
    kind: "receive",
    version: version("local-offline", "closed", "desktop", binding.generation),
  });
  await send({
    kind: "receive",
    version: version("cloud-offline", "closed", "cloud", binding.generation),
  });
  current = await state();
  const stale = {
    kind: "select" as const,
    revision: current.revision,
    candidates: current.candidates,
    version: "local-offline",
    location: "desktop",
    recoveryVerified: true,
  };
  await send({
    kind: "receive",
    version: version("late-cloud", "cloud-offline", "cloud", binding.generation),
  });
  await assert.rejects(send(stale), { code: "stale" });
  current = await state();
  const selected = (
    await send({ ...stale, revision: current.revision, candidates: current.candidates })
  ).state;
  assert.deepEqual(selected.candidates, ["local-offline"]);
  assert(selected.resolved.includes("late-cloud"));
  assert.equal(selected.active, null);
  const copied = await send({
    kind: "receive",
    version: version("late-cloud", "cloud-offline", "cloud", binding.generation),
  });
  assert.equal(copied.state.revision, selected.revision);
  await send({
    kind: "receive",
    version: version("late-cloud-new", "late-cloud", "cloud", binding.generation),
  });
  current = await state();
  assert(current.candidates.includes("late-cloud-new"));
  assert(current.candidates.includes("local-offline"));
  checks.push("selection_CAS_resolved_exact_copy_and_new_late_successor");
  // Pending recovery also needs a native fence before choosing a different whole copy.
  await assert.rejects(
    send({
      kind: "select",
      revision: current.revision,
      candidates: current.candidates,
      version: "late-cloud-new",
      location: "cloud",
      recoveryVerified: true,
    }),
    { code: "blocked" },
  );
  const pending = current.pending!;
  await send({
    kind: "fence",
    revision: current.revision,
    location: pending.location,
    generation: pending.generation,
    sourceBarrier: true,
  });
  await send({
    kind: "receive",
    version: { ...version("delete", "local-offline"), checkpoint: null },
  });
  current = await state();
  current = (
    await send({
      kind: "select",
      revision: current.revision,
      candidates: current.candidates,
      version: "delete",
      location: null,
      recoveryVerified: false,
    })
  ).state;
  assert.equal(current.selected, "delete");
  assert.equal(current.pending, null);
  assert.equal(current.active, null);
  await send({
    kind: "receive",
    version: version("direct-after-delete", "delete", "cloud", binding.generation),
  });
  current = await state();
  await assert.rejects(
    send({
      kind: "promote",
      revision: current.revision,
      version: "direct-after-delete",
      location: "cloud",
      otherOwnersSettled: true,
    }),
    { code: "conflict" },
  );
  await send({
    kind: "receive",
    version: version("after-delete-late", "late-cloud-new", "cloud", binding.generation),
  });
  assert.equal((await state()).selected, "delete");
  checks.push("ordinary_delete_without_restore_late_edit_never_revives");
  // Choosing a continuation requires actual recovery evidence; tombstone candidate closes in the same CAS.
  current = await state();
  await assert.rejects(
    send({
      kind: "select",
      revision: current.revision,
      candidates: current.candidates,
      version: "after-delete-late",
      location: "cloud",
      recoveryVerified: false,
    }),
    { code: "blocked" },
  );
  current = (
    await send({
      kind: "select",
      revision: current.revision,
      candidates: current.candidates,
      version: "after-delete-late",
      location: "cloud",
      recoveryVerified: true,
    })
  ).state;
  assert.equal(current.selected, "after-delete-late");
  assert(current.resolved.includes("delete"));
  checks.push("choose_continuation_requires_recovery_and_resolves_seen_delete");
}
