import { createModelId } from "@zcode/contracts";
import { createModelProviderId } from "@zcode/contracts";
import { createMessageId } from "../deps.js";
import { createPartId } from "../deps.js";
import { traceContextToLogContext } from "../deps.js";
import type { CompactBoundaryPayload } from "../deps.js";
import type { MessageId } from "../deps.js";
import type { Model } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { isRuntimeAttachmentEntry } from "../../agent/message-history.js";
import type { RuntimeMessageMetadata } from "../../agent/message-history.js";
import { persistRuntimeReminderMessage } from "./runtime-reminder-persistence.js";
import { removeRuntimePersistenceMessagesBestEffort } from "./runtime-reminder-persistence.js";
import { resolvePersistedReminderModel } from "./runtime-reminder-persistence.js";

export async function persistCompactSummary(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  content: string,
  summary: string,
  compactBoundary: CompactBoundaryPayload,
  traceContext: TraceContext,
  options?: {
    model?: Model;
    operationId?: string;
    postCompactReminderEntries?: readonly RuntimeMessageEntry[];
  },
): Promise<void> {
  if (!this.sessionStore) return;

  const created = Date.now();
  const persistedModel = resolvePersistedReminderModel(this, options?.model);
  // compact summary 和后续 reminder 是同一次历史替换；任一步失败都要一起回滚。
  const persistedMessageIds: MessageId[] = [messageID];
  try {
    await this.persistMessage(
      {
        id: messageID,
        sessionID: this.sessionId,
        role: "user",
        time: {
          created,
        },
        summary: {
          title: "Compact summary",
          body: summary,
          diffs: [],
        },
        agent: this.config.agentName ?? "zcode-agent",
        modelSelection: persistedModel,
        semantics: {
          origin: "agent_runtime",
          kind: "compact_summary",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        system: this.config.systemPrompt,
        tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
      },
      traceContext,
    );
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "text",
        text: content,
        synthetic: true,
        time: {
          start: created,
          end: created,
        },
      },
      traceContext,
    );
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "compaction",
        auto: compactBoundary.trigger === "auto",
        trigger: compactBoundary.trigger,
        phase: compactBoundary.phase,
        compactReason: compactBoundary.compactReason,
        tail_start_id: compactBoundary.lastSummarizedMessageId,
        compactBoundary,
        operationId: options?.operationId,
      },
      traceContext,
    );
    for (const entry of options?.postCompactReminderEntries ?? []) {
      const reminderMessageId = await persistRuntimeReminderMessage.call(
        this,
        entry,
        traceContext,
        {
          created,
          model: options?.model,
        },
      );
      if (reminderMessageId) persistedMessageIds.push(reminderMessageId);
    }
  } catch (error) {
    await removeRuntimePersistenceMessagesBestEffort.call(this, persistedMessageIds, traceContext);
    throw error;
  }
}

export function resolvePersistedModel(runtime: AgentRuntimeInternal, model?: Model) {
  if (model) return { providerId: model.providerId, modelId: model.modelId };
  const selection = runtime.getSessionModelSelection();
  return selection
    ? {
        providerId: createModelProviderId(selection.providerId),
        modelId: createModelId(selection.modelId),
      }
    : undefined;
}

export async function removeCompactPersistenceMessagesBestEffort(
  this: AgentRuntimeInternal,
  messageIds: readonly MessageId[],
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;

  for (const rollbackMessageId of new Set(messageIds)) {
    try {
      await this.sessionStore.removeMessage({
        sessionID: this.sessionId,
        messageID: rollbackMessageId,
      });
    } catch (cleanupError) {
      this.logger?.warn("Compact persistence cleanup failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        event: "compact.persistence.cleanup_failed",
        messageId: rollbackMessageId,
        module: "core.runtime",
      });
    }
  }
}

export function compactReminderPartMetadata(
  runtimeMessage: RuntimeMessageMetadata,
): Record<string, unknown> {
  return {
    runtimeMessage,
    source: runtimeMessage.source,
    visibility: "model-only",
  };
}
