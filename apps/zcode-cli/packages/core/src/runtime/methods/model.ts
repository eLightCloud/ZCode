import { beginLocalTurnPreparation } from "@zcode/contracts";

import { runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";

import type { ModelReasoningContentBlock, ModelToolCall, ModelUsage, ToolCallId } from "../deps.js";

import { buildSuspiciousEmptyDiagnostics, finalizeSuspiciousEmptyModelResult, isContextExceededFinishReason, isSuspiciousEmptyModelResult, logMediaBudgetProjection, logMediaCapabilityProjection, logModelRequestMediaSummary, normalizeModelToolCallsForRuntime, projectMessagesForInputFormat, projectMessagesForMediaBudget, projectMessagesWithMediaAttachmentPaths, readRawFinishReason } from "../helpers/index.js";

import type { RunModelTextRequestOptions, RuntimeModelTextResult } from "../model-execution-types.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { modelRequestTokenLimitLogContext } from "./model-token-limits.js";

import { createModelStreamingEventQueue } from "./model-streaming-event-queue.js";

import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";

import { isOutputTokenLimitFinishReason } from "./turn-output-token-continuation.js";

import { applyModelStreamEvent } from "./model-stream-events.js";

const TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS = 4096;

function hasToolInputLineBreak(value: string): boolean {
  return (
    value.includes("\n") || value.includes("\r") || value.includes("\\n") || value.includes("\\r")
  );
}

export async function runModelTextRequest(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
): Promise<RuntimeModelTextResult> {
  const finishAssembly = beginLocalTurnPreparation(options.traceContext, "request_assembly");
  const model = options.model;
  const executionModelSelection = {
    providerId: model.providerId,
    modelId: model.modelId,
  };
  // 闲时 turn 只覆盖了父 runtime 的默认模型，foreground child 重新建
  // request 时仍读取 session 配置，导致 provider options/capability 与本轮模型分叉。
  // turn 快照存在时必须整体采用快照，不能用 `??` 回退到用户模型的字段。
  const mediaPathMessages = await projectMessagesWithMediaAttachmentPaths(
    options.messages,
    this.artifactStore,
  );
  const capabilityProjection = projectMessagesForInputFormat(
    mediaPathMessages,
    model.properties.inputFormat,
  );
  logMediaCapabilityProjection(this.logger, options.traceContext, capabilityProjection, {
    event: "model.request.media_capability_projection",
    message: "Model request media capability projection",
    model: `${model.providerId}/${model.modelId}`,
  });
  const mediaProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
  });
  logMediaBudgetProjection(this.logger, options.traceContext, mediaProjection, {
    event: "model.request.media_projection",
    message: "Model request media budget projection",
  });
  const projectedOptions =
    mediaProjection.messages === options.messages
      ? options
      : { ...options, messages: mediaProjection.messages };
  logModelRequestMediaSummary(this.logger, projectedOptions.traceContext, {
    incomingMessages: options.messages,
    mediaProjection,
    providerMessages: projectedOptions.messages,
  });
  // 正常请求传递模型级 effective 预算，Compact 传递 min(effective, 20K) 的 summary
  // 任务预算；adapter 只做 provider 兼容映射，不再施加独立 global cap。
  const modelInvocationContext = {
    metadata: traceContextToLogContext(projectedOptions.traceContext),
    // 会话类型、重试预算与准入端口由 createRuntimeModel 绑在句柄上
    // turn step 与工具内部的模型调用同一来源。
    modelCall: {
      // 普通 Agent Step 以前只靠 metadata.querySource 在 Adapter 中反推
      // operation/actor；元数据一旦改名或缺失，就会误记为 tool_internal_model_call。
      // Runtime 已经拥有原始执行语义，应在请求边界直接声明，旧映射只作兼容兜底。
      actorKind: this.agentTelemetry.actorKind,
      operation: "agent_step" as const,
      operationId: projectedOptions.traceContext.spanId,
      ...(projectedOptions.streamRecovery
        ? {
            callCause: "recovery" as const,
            attributes: {
              streamRecoveryNumber: projectedOptions.streamRecovery.retryNumber,
            },
          }
        : {}),
    },
    statusSink: this.createModelStatusSink(projectedOptions.traceContext, projectedOptions.events, {
      ...(projectedOptions.onModelNetworkStatus
        ? { onStatus: projectedOptions.onModelNetworkStatus }
        : {}),
      ...(projectedOptions.streamRecovery
        ? { streamRecovery: projectedOptions.streamRecovery }
        : {}),
    }),
    traceContext: projectedOptions.traceContext,
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
      abortSignal: projectedOptions.abortSignal,
      model,
      traceContext: projectedOptions.traceContext,
    }),
    // SSE 已经输出后由 core recovery 重发新请求；这些请求在 adapter 看起来都是 attempt=1，
    // 必须把 recovery 次数带过去，才能把 idle timeout 从首请求窗口逐次递增。
    streamIdleTimeoutRetryNumber: projectedOptions.streamRecovery?.retryNumber,
    streamRecovery: projectedOptions.streamRecovery,
  };
  const modelRequest = {
    messages: projectedOptions.messages,
    tools: projectedOptions.tools,
    toolSearchEnabled: projectedOptions.toolSearchEnabled,
    abortSignal: projectedOptions.abortSignal,
    ...(projectedOptions.maxOutputTokens !== undefined
      ? { options: { maxOutputTokens: projectedOptions.maxOutputTokens } }
      : {}),
  };

  this.logger?.debug(
    "Model request token limits",
    modelRequestTokenLimitLogContext({
      contextWindow: model.properties.contextWindow,
      maxOutputTokens: projectedOptions.maxOutputTokens,
      modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
      traceContext: projectedOptions.traceContext,
    }),
  );
  const contextUsageSnapshot = this.buildContextUsageSnapshot(projectedOptions);
  const contextUsageBreakdown = this.buildContextUsageBreakdownFromSnapshot(contextUsageSnapshot);
  this.logContextUsageSnapshot(projectedOptions, contextUsageSnapshot);

  if (!this.shouldStreamModelText()) {
    const result = await runWithModelInvocationContext(modelInvocationContext, () =>
      model.generateText(modelRequest),
    );
    const normalizedToolCalls = normalizeModelToolCallsForRuntime(result.toolCalls, {
      logger: this.logger,
      model: executionModelSelection,
      source: "generateText",
      traceContext: projectedOptions.traceContext,
    });
    return {
      ...result,
      ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
      toolCalls: normalizedToolCalls,
    };
  }

  const streamState: {
    text: string;
    finishReason: string;
    usage: ModelUsage;
    providerMetadata: Record<string, unknown> | undefined;
  } = { text: "", finishReason: "unknown", usage: {}, providerMetadata: undefined };

  const reasoning: ModelReasoningContentBlock[] = [];
  const reasoningById = new Map<string, ModelReasoningContentBlock>();
  const toolCalls: ModelToolCall[] = [];
  const toolCallIds = new Set<string>();
  const toolInputDeltaBuffers = new Map<ToolCallId, string>();
  const publishStreamSnapshot = () =>
    options.onStreamSnapshot?.({ reasoning, text: streamState.text });
  const streamingEventQueue = createModelStreamingEventQueue({
    events: options.events,
    runtime: this,
    traceContext: options.traceContext,
  });
  const enqueueStreamingEvent = async (
    payload: Parameters<typeof streamingEventQueue.enqueue>[0],
  ) => {
    streamingEventQueue.enqueue(payload);
    await streamingEventQueue.maybeApplyBackpressure();
  };
  const enqueueStreamingEventAndDrain = async (
    payload: Parameters<typeof streamingEventQueue.enqueue>[0],
  ) => {
    streamingEventQueue.enqueue(payload);
    await streamingEventQueue.drain();
  };
  const flushToolInputDelta = async (toolCallId: ToolCallId) => {
    const delta = toolInputDeltaBuffers.get(toolCallId);
    if (!delta) {
      return;
    }
    toolInputDeltaBuffers.delete(toolCallId);
    this.logger?.debug("Model streaming tool input delta flushed", {
      ...traceContextToLogContext(options.traceContext),
      deltaLength: delta.length,
      event: "model.streaming.tool_input_delta.flush",
      module: "core.runtime",
      toolCallId,
    });
    await enqueueStreamingEvent({
      assistantMessageId: options.assistantMessageId,
      delta,
      done: false,
      kind: "tool_input_delta",
      toolCallId,
    });
  };
  const flushAllToolInputDeltas = async () => {
    for (const toolCallId of Array.from(toolInputDeltaBuffers.keys())) {
      await flushToolInputDelta(toolCallId);
    }
  };
  const appendToolInputDelta = async (toolCallId: ToolCallId, delta: string) => {
    if (!delta) {
      return;
    }
    const next = `${toolInputDeltaBuffers.get(toolCallId) ?? ""}${delta}`;
    toolInputDeltaBuffers.set(toolCallId, next);
    if (
      hasToolInputLineBreak(next) ||
      next.length >= TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS
    ) {
      // 实验原因：Write/Edit 的行数体验依赖 content 换行尽快到 UI。
      // 这里遇到真实/JSON 转义换行就 flush，同时保留超长单行兜底，
      // 避免没有换行的参数一直缓冲到 tool_input_end。
      await flushToolInputDelta(toolCallId);
    }
  };

  const modelStream = runWithModelInvocationContext(modelInvocationContext, () =>
    model.streamText(modelRequest),
  );
  finishAssembly();
  try {
    for await (const event of modelStream) {
      await applyModelStreamEvent.call(
        this,
        event,
        enqueueStreamingEvent,
        options,
        streamState,
        publishStreamSnapshot,
        reasoning,
        reasoningById,
        toolInputDeltaBuffers,
        appendToolInputDelta,
        flushToolInputDelta,
        executionModelSelection,
        toolCallIds,
        toolCalls,
        enqueueStreamingEventAndDrain,
        flushAllToolInputDeltas,
      );
    }
  } catch (error) {
    await streamingEventQueue.drain();
    throw error;
  }
  await streamingEventQueue.drain();

  const rawFinishReason = readRawFinishReason(streamState.providerMetadata);
  const outputTokenLimit = isOutputTokenLimitFinishReason(
    streamState.finishReason,
    rawFinishReason,
  );
  const contextExceeded =
    toolCalls.length === 0 &&
    !outputTokenLimit &&
    isContextExceededFinishReason(streamState.finishReason, rawFinishReason);
  if (contextExceeded) {
    // 这里若把 HTTP 200 + finish metadata 提前抛成流异常，会先被通用断流恢复接管，
    // 从而绕过 turn 层的 Reactive Compact。保留原始结果，由 turn 层统一处理超窗语义。
    this.logger?.warn("Model stream ended with provider context overflow", {
      ...traceContextToLogContext(options.traceContext),
      event: "model.runtime.stream.context_exceeded",
      finishReason: streamState.finishReason,
      module: "core.runtime",
      modelProviderId: executionModelSelection.providerId,
      modelId: executionModelSelection.modelId,
      rawFinishReason,
      textLength: streamState.text.length,
      toolCallCount: toolCalls.length,
    });
  }

  // 流在只发出 start/prelude 后以 finishReason=unknown 结束时，会被记到 turn-model-step
  // 的 suspicious empty。这里在返回 result 前再扫一遍 providerMetadata/空 completion。
  if (
    !contextExceeded &&
    !outputTokenLimit &&
    isSuspiciousEmptyModelResult(
      streamState.finishReason,
      streamState.text.length,
      toolCalls.length,
      streamState.usage,
    )
  ) {
    // zcode-plan 常返回 HTTP 200 空 SSE，需在抛错前打出 finish/providerMetadata 摘要，避免只能看到 UI 泛化文案。
    this.logger?.warn("Model stream ended with suspicious empty completion", {
      ...traceContextToLogContext(options.traceContext),
      event: "model.runtime.stream.suspicious_empty",
      module: "core.runtime",
      modelProviderId: executionModelSelection.providerId,
      modelId: executionModelSelection.modelId,
      textLength: streamState.text.length,
      toolCallCount: toolCalls.length,
      ...buildSuspiciousEmptyDiagnostics({
        finishReason: streamState.finishReason,
        providerMetadata: streamState.providerMetadata,
        rawFinishReason,
      }),
    });
    finalizeSuspiciousEmptyModelResult({
      finishReason: streamState.finishReason,
      model: executionModelSelection,
      providerMetadata: streamState.providerMetadata,
      rawFinishReason,
    });
  }

  return {
    ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
    finishReason: streamState.finishReason,
    providerMetadata: streamState.providerMetadata,
    reasoning: reasoning.length > 0 ? reasoning : undefined,
    text: streamState.text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: streamState.usage,
  };
}
