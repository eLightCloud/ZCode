import type { CompactActiveOptions } from "./compact-active.js";
import type { CompactPhase } from "@zcode/contracts";
import type { CompactReason } from "@zcode/contracts";
import type { CompactTrigger } from "@zcode/contracts";
import { requiredPluginCompactReminder } from "./required-plugin.js";
import { collectRuntimeAgentListing } from "../helpers/agent-listing.js";
import { CompactTimelineStatus } from "../deps.js";
import { SessionEventType } from "../deps.js";
import { buildCompactSummaryMessage } from "../deps.js";
import { buildManualCompactBoundary } from "../deps.js";
import { createCompactBoundaryId } from "../deps.js";
import { createMessageId } from "../deps.js";
import { getUsageTotalTokens } from "../deps.js";
import type { MessageId } from "../deps.js";
import type { SessionEvent } from "../deps.js";
import type { TraceContext } from "../deps.js";
import { CompactEntrySelection } from "../helpers/index.js";
import { buildPostCompactReadStateReminderEntries } from "../helpers/index.js";
import { buildPostCompactRuntimeEntries } from "../helpers/index.js";
import { countCompactPreservedRuntimeMessages } from "../helpers/index.js";
import { estimateRuntimeEntryTokens } from "../helpers/index.js";
import { readApprovedPlanFileReferenceEntry } from "../helpers/index.js";
import type { CompactTimelineContext } from "../types.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { legacySyntheticRuntimeMetadata } from "../../agent/message-history.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { selectPersistedCompactTail } from "../helpers/compact-preservation.js";
import { formatCompactSummaryOrThrow } from "./compact-active-helpers.js";
import { persistCompactTimelineEvent } from "./compact-active-helpers.js";
import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { filterOutputTokenContinuationEntries } from "./turn-output-token-continuation.js";
import { preserveCanonicalContextPrefix } from "./turn-output-token-continuation.js";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import { collectDiscoveredTools } from "../../tool/search/history.js";
import { compactDiscoveryMetadata } from "../../tool/search/history.js";
import { throwIfTurnAborted } from "../helpers/index.js";

export async function commitCompactSummary(
  this: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
  options: CompactActiveOptions,
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
  // Bug 根因：compact 丢弃旧公告后曾依赖下一次请求补齐，纯 Continue 无正常收集机会。
  // 在取消检查后按保留历史重建，使用继续执行的作用域，不使用摘要候选工具。
  throwIfTurnAborted(options.abortSignal);
  const registry = this.getToolRegistry();
  const preCompactDiscoveredTools = collectDiscoveredTools(activeEntries);
  const discovery = compactDiscoveryMetadata({
    boundaryId: createCompactBoundaryId(),
    preCompactDiscoveredTools: [...preCompactDiscoveredTools],
  });
  // 新检查点尚未提交；公告使用同一候选分类，避免把即将提升的工具重新公告为待加载。
  const toolAnnouncement = buildToolSearchAnnouncement(
    {
      model: compactModel,
      mode: this.config.toolSearch?.mode,
      tools: options.getContinuationTools?.() ?? this.getTools(compactModel),
      registry,
      entries: preservedEntries,
    },
    preCompactDiscoveredTools,
  );
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
    ...(toolAnnouncement ? [toolAnnouncement] : []),
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
  const summaryEntry = {
    message: { role: "user" as const, content: summaryMessageContent },
    metadata: { ...legacySyntheticRuntimeMetadata(), compactBoundary: discovery },
  };
  const postCompactEntries = buildPostCompactRuntimeEntries(activeEntries, summaryEntry, {
    postCompactReminderEntries,
    preservedEntries,
  });
  const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
    useMidConversationSystem,
  });
  const providerPostCompactTokenCount = getUsageTotalTokens(result.usage);
  const compactBoundary = buildManualCompactBoundary({
    ...discovery,
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

  // 发现检查点跟随 summary 原子保存；持久化成功后才替换 Runtime 历史。
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
