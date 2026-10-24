import {
  ConversationSyncError,
  type ConversationSyncStore,
  type SyncScope,
  type SyncState,
  type Logger,
} from "@zcode/contracts";
import {
  conversationContinuationResultSchema,
  type ConversationContinuationIntent,
  type ConversationContinuationResult,
} from "@zcode/shared";
import {
  continuationOperation as step,
  type ConversationRuntimeDirectory,
} from "./continuation-runtime-steps.js";
export function createContinuationContext(options: {
  store: ConversationSyncStore;
  runtimes: ConversationRuntimeDirectory;
  logger: Logger;
}) {
  const { store, runtimes, logger } = options;
  const journal = store.continuations;
  if (!journal || !store.executeContinuation) throw new ConversationSyncError("schema");
  function progress(
    input: ConversationContinuationIntent,
    status: ConversationContinuationResult["status"],
    phase: ConversationContinuationResult["phase"],
    reason?: ConversationContinuationResult["reason"],
    version: string | null = input.version,
  ) {
    return conversationContinuationResultSchema.parse({
      operation: input.operation,
      session: input.session,
      status,
      phase,
      location: input.target,
      version,
      ...(reason ? { reason } : {}),
    });
  }
  const command = (
    scope: SyncScope,
    input: ConversationContinuationIntent,
    name: string,
    value: Parameters<ConversationSyncStore["execute"]>[1]["command"],
  ) =>
    store.executeContinuation!(scope, input.operation, {
      session: input.session,
      operation: step(input.operation, name),
      command: value,
    });
  async function current(scope: SyncScope, session: string): Promise<SyncState> {
    const state = await store.state(scope, session);
    if (!state) throw new ConversationSyncError("not_found");
    return state;
  }
  return { store, runtimes, logger, journal, command, current, progress };
}
