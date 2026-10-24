import type { CompactActiveOptions } from "./compact-active-options.js";


import { CompactTimelineStatus } from "../deps.js";
import { CompactTrigger } from "../deps.js";
import { SessionEventType } from "../deps.js";
import { buildCompactPrompt } from "../deps.js";
import { createChildTraceContext } from "../deps.js";
import { createMessageId } from "../deps.js";
import { createPartId } from "../deps.js";
import { traceContextToLogContext } from "../deps.js";
import type { SessionEvent } from "../deps.js";
import type { TraceContext } from "../deps.js";
import { compactFailureReasonFromError } from "../helpers/index.js";
import { defaultCompactPhaseForTrigger } from "../helpers/index.js";
import { defaultCompactReasonForTrigger } from "../helpers/index.js";
import { estimateRuntimeEntryTokens } from "../helpers/index.js";
import { getRuntimeEntriesToSummarize } from "../helpers/index.js";
import { hasEnoughRuntimeEntriesToCompact } from "../helpers/index.js";
import { isModelContextExceededError } from "../helpers/index.js";
import { isModelMediaTooLargeError } from "../helpers/index.js";
import { isTurnCancellationError } from "../helpers/index.js";
import { selectCompactEntriesAfterPromptTooLong } from "../helpers/index.js";
import { throwIfTurnAborted } from "../helpers/index.js";
import { truncateCompactSummaryRequestEntriesAfterPromptTooLong } from "../helpers/index.js";
import type { CompactTimelineContext } from "../types.js";
import type { RuntimeModelTextResult } from "../model-execution-types.js";

import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactAttemptOutcome } from "./turn-loop-state.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { createCompactContextExceededFinishError } from "./compact-active-helpers.js";
import { createCompactPromptTooLongError } from "./compact-active-helpers.js";
import { persistCompactTimelineEvent } from "./compact-active-helpers.js";
import { runCompactSummaryModelRequest } from "./compact-summary-model-request.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { createRuntimeModel } from "./runtime-model.js";
import { canUseCompactSummaryTruncationFallback } from "./compact-active-selection.js";
import { isAutoCompactRetryableError } from "./compact-active-selection.js";
import { selectInitialCompactEntriesForActiveConversation } from "./compact-active-selection.js";
import { prepareCompactModelRequest } from "./compact-request-assembly.js";
import { commitCompactSummary } from "./compact-summary-commit.js";
import { AUTO_COMPACT_MAX_ATTEMPTS } from "./compact-active-policy.js";
import { COMPACT_TOOL_KEEP_MAX_COUNT } from "./compact-active-policy.js";
import { TOOL_SEARCH_NAME } from "@zcode/contracts";
import { buildToolExposure } from "../../tool/search/exposure.js";

export async function compactActiveConversationImpl(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: CompactActiveOptions = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  throwIfTurnAborted(options.abortSignal);
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactReason = options.compactReason ?? defaultCompactReasonForTrigger(trigger);
  const compactModel =
    options.model ??
    createRuntimeModel(this, {
      selection: this.getSessionModelSelection(),
    });
  const executionMaxOutputTokens = compactModel.optionSpecs.maxOutputTokens.max;
  // Active compact 会跨多个 await 保留这份成员浅快照；它依赖 RuntimeMessageEntry
  // 不可变约定。selection、provider render 和最终 replace 会创建各自拥有的副本，
  // 禁止在 compact 期间原地修改 activeEntries 内共享的 entry/message/content。
  const activeEntries = [
    ...(options.activeEntries ?? this.messageHistory.borrowReadOnlyRuntimeEntries()),
  ];
  const useMidConversationSystem =
    this.config.midConversationSystem?.mode === "force" ||
    compactModel.properties.supportsMidConversationSystem;
  const initialSelection = selectInitialCompactEntriesForActiveConversation({
    activeEntries,
    initialPromptTooLongCause: options.initialPromptTooLongCause,
    trigger,
    useMidConversationSystem,
  });
  let currentSelection = initialSelection;
  let preservedEntries = currentSelection.preservedEntries;
  const initialEntriesForSummary = currentSelection.entriesForSummary;
  let entriesForSummary = initialEntriesForSummary;
  let entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
  const preCompactTokenCount = estimateRuntimeEntryTokens(activeEntries, {
    useMidConversationSystem,
  });
  const maxAttempts = trigger === CompactTrigger.Auto ? AUTO_COMPACT_MAX_ATTEMPTS : 1;
  let attempt = 1;
  const compactTimeline: CompactTimelineContext = {
    operationId: `cmp_${crypto.randomUUID()}`,
    messageId: createMessageId(),
    partId: createPartId(),
    trigger,
    phase,
    compactReason,
    ...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
    startedAt: Date.now(),
    preCompactTokenCount,
  };

  if (!hasEnoughRuntimeEntriesToCompact(entriesForSummary)) {
    const skippedPayload = this.buildCompactTimelinePayload(compactTimeline, {
      endedAt: Date.now(),
      replace: true,
      status: CompactTimelineStatus.Skipped,
    });
    // 刚压缩过或历史太少时，/compact 是健康 no-op，不能暴露成系统故障。
    // 上层快速回填 tracker 只能记录真实 boundary，因此必须显式返回 skipped。
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      skippedPayload,
      turnTraceContext,
      events,
    );
    return {
      displayText: "Context is up to date; no compression needed",
      entries: activeEntries,
      outcome: "skipped",
      tokenCount: preCompactTokenCount,
    };
  }

  const compactStartedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
    status: CompactTimelineStatus.Started,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactStarted,
    compactStartedPayload,
    turnTraceContext,
    events,
  );
  await this.initializeMcp(turnTraceContext);
  throwIfTurnAborted(options.abortSignal);
  const runtimeCompactTools = this.getTools(compactModel);
  const registry = this.getToolRegistry();
  let compactCandidates = runtimeCompactTools.filter(
    (tool) =>
      tool.name === "Read" ||
      tool.name === TOOL_SEARCH_NAME ||
      tool.name === "DeferredToolCall" ||
      registry.get(tool.name)?.metadata.mcpPresentation,
  );
  // Bug 根因：只看 provider 能力会在 ToolSearch 被禁用或全部常驻时绕过数量保护，
  // 让大量 MCP schema 再次撑大压缩请求；实际不可启用时恢复原普通工具策略。
  if (
    !buildToolExposure({
      model: compactModel,
      mode: this.config.toolSearch?.mode,
      tools: compactCandidates,
      registry,
      entries: [],
    }).enabled
  ) {
    compactCandidates = runtimeCompactTools.filter(
      (tool) => tool.name !== TOOL_SEARCH_NAME && tool.name !== "DeferredToolCall",
    );
    if (compactCandidates.length > COMPACT_TOOL_KEEP_MAX_COUNT) compactCandidates = [];
  }

  while (true) {
    try {
      const lastSummarizedMessageId = this.latestConversationMessageId;
      const modelTraceContext = createChildTraceContext(turnTraceContext, {
        attributes: {
          model: `${compactModel.providerId}/${compactModel.modelId}`,
          querySource: "compact",
        },
      });
      const compactPrompt = buildCompactPrompt(customInstructions);
      let result: RuntimeModelTextResult;
      let compactPromptTooLongAttempts = 0;
      let stripMediaForSummary = false;
      const reselectEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        const reselected = selectCompactEntriesAfterPromptTooLong({
          currentGroupsPreserved: currentSelection.groupsPreserved,
          entries: activeEntries,
          promptTooLongCause: cause,
          trigger,
          useMidConversationSystem,
        });
        if (!reselected) return false;

        compactPromptTooLongAttempts += 1;
        currentSelection = reselected;
        preservedEntries = reselected.preservedEntries;
        entriesForSummary = reselected.entriesForSummary;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };
      const truncateEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        if (!canUseCompactSummaryTruncationFallback(trigger)) return false;

        const truncated = truncateCompactSummaryRequestEntriesAfterPromptTooLong({
          attempt: compactPromptTooLongAttempts,
          cause,
          entriesForSummary,
          logger: this.logger,
          traceContext: modelTraceContext,
          useMidConversationSystem,
        });
        if (!truncated) return false;

        compactPromptTooLongAttempts += 1;
        entriesForSummary = truncated;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };

      while (true) {
        const { compactModelRequest, networkEventStartIndex, modelStartedAt } =
          await prepareCompactModelRequest.call(
            this,
            entriesForSummary,
            compactPrompt,
            useMidConversationSystem,
            compactModel,
            modelTraceContext,
            stripMediaForSummary,
            compactCandidates,
            compactPromptTooLongAttempts,
            events,
            options,
            attempt,
            trigger,
            compactTimeline,
            registry,
          );

        try {
          result = await runCompactSummaryModelRequest({
            logger: this.logger,
            model: compactModel,
            request: compactModelRequest,
          });
        } catch (error) {
          await recordModelUsageFact(this, {
            attemptIndex: compactPromptTooLongAttempts,
            error,
            events,
            model: compactModel,
            networkEventStartIndex,
            querySource: "compact",
            startedAt: modelStartedAt,
            status: isTurnCancellationError(error, options.abortSignal) ? "cancelled" : "error",
            traceContext: modelTraceContext,
          });
          if (isTurnCancellationError(error, options.abortSignal)) {
            throw error;
          }
          if (isModelMediaTooLargeError(error) && !stripMediaForSummary) {
            stripMediaForSummary = true;
            this.logger?.info(
              "Compact summary hit media-size error; retrying with stripped media",
              {
                ...traceContextToLogContext(modelTraceContext),
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "compact.request.media_too_large.retry",
                module: "core.runtime",
              },
            );
            continue;
          }
          if (isModelContextExceededError(error)) {
            if (reselectEntriesAfterPromptTooLong(error)) continue;
            if (truncateEntriesAfterPromptTooLong(error)) continue;
            throw createCompactPromptTooLongError({
              attempt: compactPromptTooLongAttempts,
              cause: error,
              preCompactTokenCount,
            });
          }
          throw error;
        }

        await recordModelUsageFact(this, {
          attemptIndex: compactPromptTooLongAttempts,
          events,
          model: compactModel,
          networkEventStartIndex,
          querySource: "compact",
          result,
          startedAt: modelStartedAt,
          status: "completed",
          toolCallCount: this.extractToolCallsFromResult(result).length,
          traceContext: modelTraceContext,
        });
        const contextError = createCompactContextExceededFinishError(result);
        if (contextError) {
          // compact summary 也可能以 finishReason 返回超窗而不是 throw；
          // 必须先进入同一套 recent preserve 重选逻辑，避免 finishReason 路径丢上下文。
          if (reselectEntriesAfterPromptTooLong(contextError)) continue;
          if (truncateEntriesAfterPromptTooLong(contextError)) continue;
          throw createCompactPromptTooLongError({
            attempt: compactPromptTooLongAttempts,
            cause: contextError,
            preCompactTokenCount,
          });
        }
        break;
      }

      return await commitCompactSummary.call(
        this,
        result,
        options,
        modelTraceContext,
        preservedEntries,
        compactModel,
        events,
        currentSelection,
        activeEntries,
        useMidConversationSystem,
        compactReason,
        customInstructions,
        lastSummarizedMessageId,
        phase,
        preCompactTokenCount,
        entriesToSummarize,
        turnTraceContext,
        trigger,
        compactTimeline,
        maxAttempts,
        attempt,
      );
    } catch (error) {
      if (
        trigger === CompactTrigger.Auto &&
        attempt < maxAttempts &&
        !isTurnCancellationError(error, options.abortSignal) &&
        isAutoCompactRetryableError(error)
      ) {
        attempt += 1;
        const retryPayload = this.buildCompactTimelinePayload(compactTimeline, {
          attempt,
          maxAttempts,
          reason: compactFailureReasonFromError(error),
          status: CompactTimelineStatus.Retrying,
        });
        // 自动 compact 的中间失败不能提前落成 failed 横线。
        // 这里在同一个 operation 上发 retrying，直到第 3 次仍失败才写最终 failed。
        await persistCompactTimelineEvent(
          this,
          SessionEventType.CompactStarted,
          retryPayload,
          turnTraceContext,
          events,
        );
        this.logger?.warn("Auto compact retrying", {
          ...traceContextToLogContext(turnTraceContext),
          attempt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "compact.auto.retrying",
          maxAttempts,
          module: "core.runtime",
          timelineStatus: CompactTimelineStatus.Retrying,
        });
        currentSelection = initialSelection;
        preservedEntries = currentSelection.preservedEntries;
        entriesForSummary = initialEntriesForSummary;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        continue;
      }
      await this.finishCompactTimelineFailure({
        abortSignal: options.abortSignal,
        attempt,
        error,
        events,
        maxAttempts: maxAttempts > 1 ? maxAttempts : undefined,
        timeline: compactTimeline,
        traceContext: turnTraceContext,
      });
      throw error;
    }
  }
}
