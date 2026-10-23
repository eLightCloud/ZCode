import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  SessionEventType,
  traceContextToLogContext,
} from "../deps.js";

import type { ModelToolContract, SessionEvent, TraceContext } from "../deps.js";

import {
  logCompactMediaRetryProjection,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  projectCompactMediaForRetry,
  projectMessagesForModelMediaPolicy,
} from "../helpers/index.js";

import type { CompactTimelineContext } from "../types.js";

import type { Model } from "../deps.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { type RuntimeMessageEntry } from "../../agent/message-history.js";

import { buildCompactSummaryRequestMessages } from "./compact-active-helpers.js";

import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";

import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";

import { filterOutputTokenContinuationEntries } from "./turn-output-token-continuation.js";

export async function prepareCompactModelRequest(
  this: AgentRuntimeInternal,
  entriesForSummary: RuntimeMessageEntry[],
  compactPrompt: string,
  useMidConversationSystem: boolean,
  compactModel: Model,
  modelTraceContext: TraceContext,
  stripMediaForSummary: boolean,
  compactTools: ModelToolContract[],
  compactPromptTooLongAttempts: number,
  events: SessionEvent[],
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
  attempt: number,
  trigger: string,
  compactTimeline: CompactTimelineContext,
) {
  const requestMessages = buildCompactSummaryRequestMessages(entriesForSummary, compactPrompt, {
    useMidConversationSystem,
  });
  const recordableEntries = filterOutputTokenContinuationEntries(entriesForSummary);
  const recordableRequestMessages =
    recordableEntries === entriesForSummary
      ? requestMessages
      : buildCompactSummaryRequestMessages(recordableEntries, compactPrompt, {
          useMidConversationSystem,
        });
  // Compact 曾只执行 capability projection，漏掉普通 turn 共用的聚合
  // 媒体预算；统一走模型媒体策略，避免 summary 请求绕过全局请求上限。
  const mediaPolicyProjection = projectMessagesForModelMediaPolicy(
    requestMessages,
    compactModel.properties.inputFormat,
  );
  logMediaCapabilityProjection(
    this.logger,
    modelTraceContext,
    mediaPolicyProjection.capabilityProjection,
    {
      event: "compact.request.media_capability_projection",
      message: "Compact request media capability projection",
      model: `${compactModel.providerId}/${compactModel.modelId}`,
    },
  );
  logMediaBudgetProjection(
    this.logger,
    modelTraceContext,
    mediaPolicyProjection.mediaBudgetProjection,
    {
      event: "compact.request.media_projection",
      message: "Compact request media budget projection",
    },
  );
  let projectedRequestMessages = mediaPolicyProjection.messages;
  let projectedRecordableMessages =
    recordableRequestMessages === requestMessages
      ? projectedRequestMessages
      : projectMessagesForModelMediaPolicy(
          recordableRequestMessages,
          compactModel.properties.inputFormat,
        ).messages;
  if (stripMediaForSummary) {
    // 复用通用 media budget 文案会污染 summary 的 provider-visible 内容。
    const mediaProjection = projectCompactMediaForRetry(projectedRequestMessages);
    projectedRequestMessages = mediaProjection.messages;
    projectedRecordableMessages =
      recordableRequestMessages === requestMessages
        ? projectedRequestMessages
        : projectCompactMediaForRetry(projectedRecordableMessages).messages;
    logCompactMediaRetryProjection(this.logger, modelTraceContext, mediaProjection);
  }

  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      // 事件误用了含 Continue 的实际请求数组，导致 query-local 提示进入持久化轨迹。
      // 与 v0.16.6 一致：事件记录过滤后的投影，下面的 provider 请求仍使用完整上下文。
      messages: projectedRecordableMessages,
      providerId: String(compactModel.providerId),
      modelId: String(compactModel.modelId),
      querySource: "compact",
      toolCount: compactTools.length,
      compactPromptTooLongRetry: compactPromptTooLongAttempts,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  events.push(modelRequestEvent);
  const modelStartedAt = Date.now();
  const networkEventStartIndex = events.length;
  const compactSummaryMaxOutputTokens = capCompactSummaryMaxOutputTokens(compactModel);
  const compactModelRequest = {
    abortSignal: options.abortSignal,
    maxOutputTokens: compactSummaryMaxOutputTokens,
    messages: projectedRequestMessages,
    metadata: traceContextToLogContext(modelTraceContext),
    modelCall: {
      attributes: {
        compactionOuterAttempt: attempt,
        compactionTrigger: trigger,
      },
      operation: "context_compaction" as const,
      operationId: compactTimeline.operationId,
    },
    statusSink: this.createModelStatusSink(modelTraceContext, events),
    // compact 的首个真实 provider event 结束 SSE retry 资格；隐藏 partial 在
    // content block 提交前仍可丢弃并 HTTP fallback，block end 后则禁止任何重放。
    preserveProviderStreamBoundaries: true,
    traceContext: modelTraceContext,
    tools: compactTools,
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
      abortSignal: options.abortSignal,
      model: compactModel,
      traceContext: modelTraceContext,
    }),
  };
  return { compactModelRequest, networkEventStartIndex, modelStartedAt };
}

export function capCompactSummaryMaxOutputTokens(model: Model): number {
  // Compact 是独立执行链，在这里显式选择模型上限与 summary 20K 上限中的较小值。
  const desired = Math.min(
    resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  );
  return Math.min(desired, model.optionSpecs.maxOutputTokens.max);
}
