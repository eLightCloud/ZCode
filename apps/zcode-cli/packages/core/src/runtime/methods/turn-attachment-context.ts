import type { MessagePart, TraceContext, TurnAttachment, TurnId } from "../deps.js";

import {
  logResolvedTurnAttachments,
  resolveTurnAttachments,
  runtimeMetadataForSyntheticUserMessageSource,
} from "../helpers/index.js";

import type { ExecuteTurnOptions } from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

export async function resolveAttachmentsAndSharedContext(
  this: AgentRuntimeInternal,
  attachments: TurnAttachment[] | undefined,
  turnAbortSignal: AbortSignal,
  turnTraceContext: TraceContext,
  turnId: TurnId,
  options: ExecuteTurnOptions | undefined,
) {
  const resolvedAttachments = await resolveTurnAttachments(attachments, {
    abortSignal: turnAbortSignal,
    artifactStore: this.artifactStore,
    fileSystemPort: this.fileSystemPort,
    imageProcessorPort: this.imageProcessorPort,
    sessionId: this.sessionId,
    traceContext: turnTraceContext,
    turnId,
    workingDirectory: this.workingDirectory,
  });
  logResolvedTurnAttachments(this.logger, turnTraceContext, resolvedAttachments);
  const sharedContextRefs = options?.sharedContextRefs ?? options?.intent?.sharedContextRefs;
  if (sharedContextRefs && sharedContextRefs.length > 0) {
    const [reference] = sharedContextRefs;
    if (!reference || reference.kind !== "shared_context_import") {
      throw new Error("invalid shared context reference");
    }
    if (!this.sessionStore) throw new Error("shared context import storage is unavailable");
    const alreadyHydrated = this.messageHistory
      .borrowReadOnlyRuntimeEntries()
      .some((entry) => entry.kind !== "attachment" && entry.metadata?.source === "shared_context");
    if (!alreadyHydrated) {
      const importedMessages = await this.sessionStore.messages({
        sessionID: this.sessionId,
      });
      const contextMessage = importedMessages.find(
        (message) =>
          message.info.role === "user" &&
          message.info.source === "shared_context" &&
          message.info.metadata &&
          typeof message.info.metadata === "object" &&
          (message.info.metadata as Record<string, unknown>).contextId === reference.context_id,
      );
      const contextText = contextMessage?.parts
        .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!contextText) throw new Error("shared context content is unavailable");
      this.messageHistory.addUser(
        contextText,
        runtimeMetadataForSyntheticUserMessageSource("shared_context"),
      );
    }
  }
  return resolvedAttachments;
}
