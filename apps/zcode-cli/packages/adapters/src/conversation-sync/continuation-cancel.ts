import { ConversationSyncError, type SyncScope } from "@zcode/contracts";
import {
  continuationOperation as step,
  runtimeState,
  reserveRuntime,
  runtimeCode,
} from "./continuation-runtime-steps.js";
import type { createContinuationContext } from "./continuation-context.js";
/** Cancel preparation before commit; preserve exact original source work and old target fences. */
export function createContinuationCancellation(
  context: ReturnType<typeof createContinuationContext>,
) {
  const { store, runtimes, logger, journal, command, current, progress } = context;
  return async function cancel(scope: SyncScope, session: string, operation: string) {
    const record = await journal!.requestCancel(scope, session, operation);
    if (record.result?.status === "cancelled") return record.result;
    if (record.result?.status !== "cancelling")
      return progress(record.intent, "forward_only", "granted");
    const input = record.intent;
    const committed =
      (await store.receipt(scope, session, step(operation, "grant"))) ??
      (await store.receipt(scope, session, step(operation, "select")));
    if (committed) return progress(input, "forward_only", "granted");
    let state = await current(scope, session);
    if (input.kind === "handoff") {
      if (state.handoff?.id === operation && state.handoff.phase === "requested") {
        const receipt = await command(scope, input, "cancel", {
          kind: "cancel",
          handoff: operation,
        });
        state = receipt.state;
      }
      if (state.handoff?.id === operation && ["granted", "activated"].includes(state.handoff.phase))
        return progress(input, "forward_only", "granted");
      const sourceLocation =
        state.handoff?.id === operation ? state.handoff.source : state.active?.location;
      if (sourceLocation) {
        const runtime = await runtimes.runtime(scope, sourceLocation),
          local = await runtimeState(runtime, session, operation);
        if (
          state.active &&
          state.handoff?.id === operation &&
          state.handoff?.phase === "cancelled"
        ) {
          if (local?.operation !== operation)
            await reserveRuntime(store, scope, runtime, session, operation);
          await runtime.control({
            kind: "cancel",
            session,
            operation,
            version: state.active.version,
            generation: state.active.generation,
          });
        }
      }
    }
    const latest = await current(scope, session);
    const offlineLocations =
      input.kind === "select" ? await journal!.offlineLocations(scope, session) : [];
    const candidateSources: string[] = [];
    if (input.kind === "select") {
      for (const id of latest.candidates) {
        const candidate = await store.version(scope, session, id);
        if (candidate && candidate.id !== latest.selected && candidate.generation === 0)
          candidateSources.push(candidate.location);
      }
    }
    const locations = [
      ...new Set(
        [
          input.target,
          ...offlineLocations,
          ...candidateSources,
          input.kind !== "offline" ? latest.active?.location : undefined,
          latest.handoff?.id === operation ? latest.handoff.source : undefined,
        ].filter((v): v is string => !!v),
      ),
    ];
    for (const location of locations) {
      try {
        const runtime = await runtimes.runtime(scope, location),
          local = await runtimeState(runtime, session, operation);
        if (
          !local ||
          local.operation !== operation ||
          !["active", "cancelled"].includes(local.state)
        ) {
          // A central fence is never undone by cancelling a choice. Keep that former
          // owner closed; a fresh whole-copy intent may reserve it after cancellation.
          if (input.kind === "select" && !latest.active && location !== input.target) continue;
          await runtime.control({ kind: "cancel", session, operation });
        }
      } catch (error) {
        if (
          location !== input.target ||
          location === latest.active?.location ||
          runtimeCode(error) !== "unavailable"
        )
          throw error;
        logger.warn("Cancelled target cleanup deferred", {
          event: "conversation.continuation",
          sessionId: session,
          operationId: operation,
          outcome: "target_unavailable",
        });
      }
    }
    const result = progress(input, "cancelled", "cancelled");
    await journal!.finish(scope, result);
    return result;
  };
}
