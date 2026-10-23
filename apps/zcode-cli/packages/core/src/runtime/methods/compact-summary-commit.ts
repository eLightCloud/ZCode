import type { CompactPhase, CompactReason, CompactTrigger } from "@zcode/contracts";
import { requiredPluginCompactReminder } from "./required-plugin.js";

import { collectRuntimeAgentListing } from "../helpers/agent-listing.js";

import {
  CompactTimelineStatus,
  SessionEventType,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
  createMessageId,
  getUsageTotalTokens,
} from "../deps.js";

import type { MessageId, SessionEvent, TraceContext } from "../deps.js";

import {
  CompactEntrySelection,
  buildPostCompactReadStateReminderEntries,
  buildPostCompactRuntimeEntries,
  countCompactPreservedRuntimeMessages,
  estimateRuntimeEntryTokens,
  readApprovedPlanFileReferenceEntry,
} from "../helpers/index.js";

import type { CompactTimelineContext, RuntimeModelTextResult } from "../types.js";

import type { Model } from "../deps.js";

import type { AgentRuntimeInternal } from "../internal.js";

import {
  legacySyntheticRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

import { selectPersistedCompactTail } from "../helpers/compact-preservation.js";

import {
  formatCompactSummaryOrThrow,
  persistCompactTimelineEvent,
} from "./compact-active-helpers.js";

import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";

import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";

export async function commitCompactSummary(
  this: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    agentListingTools?: readonly { name: string }[];
    activeEntries?: readonly RuntimeMessageEntry[];
  },
  modelTraceContext: TraceContext,
  preservedEntries: RuntimeMessageEntry[],
  compactModel: Model,
  events: SessionEvent[],
  currentSelection: CompactEntrySelection,
  activeEntries: RuntimeMessageEntry[],
  useMidConversationSystem: boolean,
  compactReason: CompactReason,
  customInstructions: string | undefined,
  lastSummarizedMessageId: MessageId | undefined,
  phase: CompactPhase,
  preCompactTokenCount: number,
  entriesToSummarize: RuntimeMessageEntry[],
  turnTraceContext: TraceContext,
  trigger: CompactTrigger,
  compactTimeline: CompactTimelineContext,
  maxAttempts: number,
  attempt: number,
): Promise<Awaited<ReturnType<AgentRuntimeInternal["compactActiveConversation"]>>> {
  const summary = formatCompactSummaryOrThrow(this, result);
  const persistedSummary = summary;
  const planFileReferenceEntry = this.fileSystemPort
    ? await readApprovedPlanFileReferenceEntry({
        abortSignal: options.abortSignal,
        fileSystemPort: this.fileSystemPort,
        sessionId: this.sessionId,
        traceContext: modelTraceContext,
        workspaceRoot: this.workspaceRoot,
      })
    : undefined;
  const agentListingEntry = collectRuntimeAgentListing(
    this,
    preservedEntries,
    options.agentListingTools ?? this.getTools(options.model ?? compactModel),
  );
  const postCompactReminderEntries = [
    ...requiredPluginCompactReminder(this.messageHistory.borrowReadOnlyRuntimeEntries()),
    ...(agentListingEntry ? [agentListingEntry] : []),
    ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
    ...buildPostCompactReadStateReminderEntries({
      preservedEntries,
      readFileState: this.readFileState,
    }),
  ];

  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: summary,
      stopReason: result.finishReason,
      usage: result.usage,
      querySource: "compact",
      toolCallCount: 0,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  events.push(modelCompleteEvent);

  const summaryMessageId = createMessageId();
  const summaryMessageContent = buildCompactSummaryMessage(persistedSummary, {
    suppressFollowup: true,
  });
  // Continue 没有对应 Session message；无 store 的统计也不能把它计入保留记录。
  const recordablePreservedEntries = filterOutputTokenContinuationEntries(preservedEntries);
  const preservation = this.sessionStore
    ? await selectPersistedCompactTail({
        sessionStore: this.sessionStore,
        sessionId: this.sessionId,
        groupsPreserved: currentSelection.groupsPreserved,
        summaryMessageId,
      })
    : { keptMessageCount: countCompactPreservedRuntimeMessages(recordablePreservedEntries) };
  const postCompactEntries = buildPostCompactRuntimeEntries(
    activeEntries,
    {
      message: {
        role: "user",
        content: summaryMessageContent,
      },
      metadata: legacySyntheticRuntimeMetadata(),
    },
    {
      postCompactReminderEntries,
      preservedEntries,
    },
  );
  const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
    useMidConversationSystem,
  });
  const providerPostCompactTokenCount = getUsageTotalTokens(result.usage);
  const compactBoundary = buildManualCompactBoundary({
    boundaryId: createCompactBoundaryId(),
    autoCompactThreshold: options.autoCompactThreshold,
    compactReason,
    customInstructions,
    lastSummarizedMessageId,
    phase,
    postCompactTokenCount: providerPostCompactTokenCount,
    preCompactTokenCount,
    summarizedMessageCount: entriesToSummarize.length,
    summaryMessageId,
    traceContext: turnTraceContext,
    trigger,
    ...(currentSelection.groupsPreserved > 0
      ? {
          keptMessageCount: preservation.keptMessageCount,
        }
      : {}),
    preservedSegment: preservation.preservedSegment,
    truePostCompactTokenCount,
    willRetriggerNextTurn:
      options.autoCompactThreshold !== undefined
        ? truePostCompactTokenCount >= options.autoCompactThreshold
        : undefined,
  });

  await this.persistCompactSummary(
    summaryMessageId,
    summaryMessageContent,
    persistedSummary,
    compactBoundary,
    modelTraceContext,
    {
      model: compactModel,
      operationId: compactTimeline.operationId,
      postCompactReminderEntries,
    },
  );

  const compactBoundaryEvent = this.createEvent(
    SessionEventType.CompactBoundary,
    compactBoundary,
    turnTraceContext,
  );
  await this.appendEvent(compactBoundaryEvent, turnTraceContext);
  events.push(compactBoundaryEvent);

  const compactCompletedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
    boundaryId: compactBoundary.boundaryId,
    endedAt: Date.now(),
    postCompactTokenCount: providerPostCompactTokenCount,
    replace: true,
    status: CompactTimelineStatus.Completed,
    summaryMessageId,
    tailStartMessageId: lastSummarizedMessageId,
    truePostCompactTokenCount,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactCompleted,
    compactCompletedPayload,
    turnTraceContext,
    events,
  );

  this.latestConversationMessageId = summaryMessageId;
  const recordablePostCompactEntries = filterOutputTokenContinuationEntries(postCompactEntries);
  this.messageHistory.replaceMessages(
    options.activeEntries
      ? preserveCanonicalContextPrefix(
          this.messageHistory.borrowReadOnlyRuntimeEntries(),
          recordablePostCompactEntries,
        )
      : recordablePostCompactEntries,
  );
  this.readFileState.clear();
  resetProjectMemoryRecall(this);

  return {
    displayText: "Compacted",
    entries: postCompactEntries,
    outcome: "compacted",
    tokenCount: providerPostCompactTokenCount,
  };
}
