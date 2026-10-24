import {
  ConversationSyncError,
  type ConversationSyncStore,
  type SyncScope,
  type Logger,
} from "@zcode/contracts";
import {
  conversationContinuationIntentSchema,
  conversationContinuationOptionsSchema,
  type ConversationContinuationIntent,
} from "@zcode/shared";
import { canonical } from "./canonical.js";
import { createContinuationContext } from "./continuation-context.js";
import { createContinuationCancellation } from "./continuation-cancel.js";
import {
  continuationOperation as step,
  runtimeCode,
  reserveRuntime,
  captureRuntime,
  stageRuntime,
  type ConversationRuntimeDirectory,
} from "./continuation-runtime-steps.js";

/** Native orchestration only. Existing receipts are authoritative; no accepted input queue. */
export function createConversationContinuation(options: {
  store: ConversationSyncStore;
  runtimes: ConversationRuntimeDirectory;
  logger: Logger;
}) {
  const context = createContinuationContext(options);
  const { store, runtimes, logger, journal, command, current, progress } = context;
  const cancel = createContinuationCancellation(context);
  async function complete(
    scope: SyncScope,
    input: ConversationContinuationIntent,
    version: string,
    generation: number,
    offline = false,
  ) {
    const runtime = await runtimes.runtime(scope, input.target);
    await runtime.control({ kind: "apply", session: input.session, operation: input.operation });
    if (!offline) {
      const prior = await store.receipt(scope, input.session, step(input.operation, "activate"));
      if (!prior) {
        const state = await current(scope, input.session);
        await command(scope, input, "activate", {
          kind: "activate",
          revision: state.revision,
          location: input.target,
          generation,
          version,
          recoveryVerified: true,
        });
      }
    }
    await runtime.control({
      kind: offline ? "activateOffline" : "activate",
      session: input.session,
      operation: input.operation,
      generation: offline ? 0 : generation,
      version,
    } as Parameters<typeof runtime.control>[0]);
    const result = progress(input, "ready", "ready", undefined, version);
    await journal.finish(scope, result);
    return result;
  }
  async function run(scope: SyncScope, raw: unknown) {
    const input = conversationContinuationIntentSchema.parse(raw);
    const record = await journal.begin(scope, input);
    if (record.result?.status === "cancelling")
      return cancel(scope, input.session, input.operation);
    if (record.result && record.result.status !== "forward_only") return record.result;
    logger.info("Continuation intent resumed", {
      event: "conversation.continuation",
      sessionId: input.session,
      operationId: input.operation,
      phase: input.kind,
      outcome: "started",
    });
    try {
      if (record.result?.status === "forward_only" && input.kind === "offline")
        return complete(scope, input, input.version, 0, true);
      let state = await current(scope, input.session);
      const saved = await store.version(scope, input.session, input.version);
      if (!saved?.checkpoint) throw new ConversationSyncError("blocked");
      const chosen = await store.receipt(scope, input.session, step(input.operation, "select"));
      const granted = await store.receipt(scope, input.session, step(input.operation, "grant"));
      if (chosen?.state.pending)
        return complete(
          scope,
          input,
          chosen.state.pending.version,
          chosen.state.pending.generation,
        );
      if (granted?.state.pending)
        return complete(
          scope,
          input,
          granted.state.pending.version,
          granted.state.pending.generation,
        );
      const target = await runtimes.runtime(scope, input.target);
      const offlineLocations = await journal!.offlineLocations(scope, input.session);
      if (input.kind === "offline") {
        const sourceLocation = state.active?.location ?? saved.location;
        if (sourceLocation === input.target) throw new ConversationSyncError("blocked");
        try {
          await runtimes.runtime(scope, sourceLocation);
          throw new ConversationSyncError("blocked");
        } catch (error) {
          if (error instanceof ConversationSyncError) throw error;
          if (!["unavailable", "not_found"].includes(runtimeCode(error))) throw error;
        }
        await reserveRuntime(store, scope, target, input.session, input.operation, true);
        await captureRuntime(
          store,
          scope,
          target,
          input.target,
          input.session,
          input.operation,
          input.version,
        );
        state = await current(scope, input.session);
        if (
          canonical([...state.candidates].sort()) !==
          canonical([...new Set(input.candidates)].sort())
        )
          return progress(input, "stale", "preparing", "changed");
        await stageRuntime(store, scope, target, input.session, input.operation, saved, "offline");
        const committed = await journal.commitOffline(scope, input.session, input.operation);
        if (committed.result?.status === "cancelling")
          return cancel(scope, input.session, input.operation);
        return complete(scope, input, input.version, 0, true);
      }
      if (input.kind === "handoff") {
        // 已就绪的离线分支即使尚无新检查点也可能有已接纳工作；不能以候选为空推定它不存在。
        if (offlineLocations.length) throw new ConversationSyncError("blocked");
        const begun = await store.receipt(scope, input.session, step(input.operation, "begin"));
        if (!begun) {
          if (!state.active) throw new ConversationSyncError("blocked");
          await command(scope, input, "begin", {
            kind: "begin",
            revision: input.revision,
            handoff: input.operation,
            source: state.active.location,
            generation: state.active.generation,
            target: input.target,
            baseline: input.version,
          });
          state = await current(scope, input.session);
        }
        const h = state.handoff;
        if (!h || h.id !== input.operation || h.phase === "cancelled")
          return progress(input, "cancelled", "cancelled");
        const source = await runtimes.runtime(scope, h.source);
        await reserveRuntime(store, scope, source, input.session, input.operation);
        const final = await captureRuntime(
          store,
          scope,
          source,
          h.source,
          input.session,
          input.operation,
          h.baseline,
        );
        if (
          !final?.checkpoint ||
          (final.id !== h.baseline &&
            (final.location !== h.source || final.generation !== h.generation))
        )
          throw new ConversationSyncError("blocked");
        await reserveRuntime(store, scope, target, input.session, input.operation);
        await captureRuntime(
          store,
          scope,
          target,
          input.target,
          input.session,
          input.operation,
          input.version,
        );
        await stageRuntime(store, scope, target, input.session, input.operation, final);
        state = await current(scope, input.session);
        const receipt = await command(scope, input, "grant", {
          kind: "grant",
          revision: state.revision,
          handoff: input.operation,
          checkpoint: final.id,
          sourceBarrier: true,
          dependenciesVerified: true,
        });
        return complete(scope, input, final.id, receipt.state.pending!.generation);
      }
      const independentSources: string[] = [];
      for (const id of state.candidates) {
        const candidate = await store.version(scope, input.session, id);
        if (candidate && candidate.id !== state.selected && candidate.generation === 0)
          independentSources.push(candidate.location);
      }
      // Historical creator locations do not imply current admission. Explicit offline owners,
      // including those with accepted work but no checkpoint, must actually settle.
      const locations = [
        ...new Set(
          [state.active?.location, ...offlineLocations, ...independentSources, input.target].filter(
            (value): value is string => !!value,
          ),
        ),
      ];
      for (const location of locations) {
        const runtime = await runtimes.runtime(scope, location);
        await reserveRuntime(store, scope, runtime, input.session, input.operation);
        await captureRuntime(
          store,
          scope,
          runtime,
          location,
          input.session,
          input.operation,
          input.version,
        );
      }
      state = await current(scope, input.session);
      if (
        canonical([...state.candidates].sort()) !== canonical([...new Set(input.candidates)].sort())
      )
        return progress(input, "stale", "preparing", "changed");
      await stageRuntime(store, scope, target, input.session, input.operation, saved);
      const fenced = await store.receipt(scope, input.session, step(input.operation, "fence"));
      if (!fenced && state.active) {
        await command(scope, input, "fence", {
          kind: "fence",
          revision: state.revision,
          location: state.active.location,
          generation: state.active.generation,
          sourceBarrier: true,
        });
        state = await current(scope, input.session);
      }
      const receipt = await command(scope, input, "select", {
        kind: "select",
        revision: state.revision,
        candidates: input.candidates,
        version: input.version,
        location: input.target,
        recoveryVerified: true,
      });
      return complete(scope, input, input.version, receipt.state.pending!.generation);
    } catch (error) {
      logger.warn("Continuation not ready", {
        event: "conversation.continuation",
        sessionId: input.session,
        operationId: input.operation,
        outcome: "waiting",
        code: runtimeCode(error),
      });
      if (
        error instanceof ConversationSyncError &&
        ["scope", "invalid", "not_found", "conflict"].includes(error.code)
      )
        throw error;
      if (error instanceof ConversationSyncError && error.code === "stale")
        return progress(input, "stale", "preparing", "changed");
      const granted =
        (await store.receipt(scope, input.session, step(input.operation, "grant"))) ??
        (await store.receipt(scope, input.session, step(input.operation, "select")));
      return progress(
        input,
        "waiting",
        granted ? "granted" : "settling",
        runtimeCode(error) === "busy" ? "busy" : "unavailable",
        granted?.state.pending?.version ?? input.version,
      );
    }
  }

  return {
    run,
    cancel,
    async options(scope: SyncScope, session: string) {
      const state = await current(scope, session),
        pending = await journal.read(scope, session);
      return conversationContinuationOptionsSchema.parse({
        session,
        revision: state.revision,
        candidates: state.candidates,
        active: state.active,
        pending: state.pending,
        handoff: state.handoff
          ? {
              id: state.handoff.id,
              phase: state.handoff.phase,
              source: state.handoff.source,
              target: state.handoff.target,
            }
          : null,
        inflight: pending?.intent ?? null,
        targets: await runtimes.list(scope),
      });
    },
  };
}
