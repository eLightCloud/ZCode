import { CoreErrorType, TurnMachineImpl, createCoreError } from "../deps.js";

import type { MessageId, Model, ModelToolCall, ModelToolContract, TraceContext } from "../deps.js";

import { type RuntimeMessageEntry } from "../../agent/message-history.js";

import { projectExecutionErrorPayload } from "../helpers/index.js";

import type {
  DrainedPendingInputDiagnostics,
  RunModelTextRequestOptions,
  RuntimeModelTextResult,
  StreamedToolExecutionResult,
} from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { executeToolCallsForModelStep } from "./turn-tools.js";

import {
  AssistantPersistenceAnchor,
  finishModelStepWithoutToolCalls,
  persistCompletedAssistantStep,
  persistOutputTokenLimitErrorCarrier,
} from "./turn-stop.js";

import type { RegularTurnLoopState } from "./turn-loop-state.js";

import { recordModelHistoryRound } from "./turn-loop-state.js";

import {
  OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
  appendOutputTokenContinuation,
  commitAssistantToTurnRequest,
  completeOutputTokenRecovery,
} from "./turn-output-token-continuation.js";

import type { ModelStepResult } from "./model-step-contract.js";

export async function settleModelStepTools(
  this: AgentRuntimeInternal,
  toolCalls: ModelToolCall[],
  streamingToolCoordinator: {
    accept(toolCall: ModelToolCall): void;
    abandon(reason: "cancelled" | "model_failed"): Promise<void>;
    drain(toolCalls: readonly ModelToolCall[]): Promise<StreamedToolExecutionResult[]>;
    recordReasoningDelta(text: string): void;
    recordTextDelta(text: string): void;
    recoverFromModelFailure(
      error: unknown,
      assistantCreatedAt: number,
      recoveryOptions?: { failedRequestId?: string },
    ): Promise<boolean>;
    settleForModelFallback(assistantCreatedAt: number): Promise<boolean>;
  },
  outputTokenContinuation: string,
  state: RegularTurnLoopState,
  options: {
    drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
    latestRealUserMessageIndex?: number;
    messages: RunModelTextRequestOptions["messages"];
    sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
    recordedMessages: RunModelTextRequestOptions["messages"];
    requestEntries: readonly RuntimeMessageEntry[];
    tools: ModelToolContract[];
  },
  assistantPersistenceAnchor: AssistantPersistenceAnchor,
  assistantCreatedAt: number,
  assistantMessageId: MessageId,
  modelTraceContext: TraceContext,
  result: RuntimeModelTextResult,
  model: Model,
): Promise<ModelStepResult> {
  const executableToolCalls = toolCalls.filter((toolCall) => !toolCall.providerExecuted);
  const streamedToolResults = await streamingToolCoordinator.drain(executableToolCalls);
  if (outputTokenContinuation !== "none") {
    // 首次命中 output-limit 时，当前 request 可能带有一次性的 project-memory attachment；
    // query-local 状态必须从实际请求数组推进，不能退回请求前的数组。
    state.turnRequestState.entries = options.requestEntries;
    const assistantCommitted = await persistCompletedAssistantStep(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      includeEmptyAssistant: false,
      modelTraceContext,
      result,
    });
    if (assistantCommitted) recordModelHistoryRound(state);
    if (outputTokenContinuation === "continue") {
      appendOutputTokenContinuation(state.turnRequestState);
      state.reactiveCompactAttemptedInCurrentModelStep = false;
      state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
      return "output_continuation";
    }

    const exhaustedError = createCoreError(
      CoreErrorType.ModelError,
      OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
      {
        context: {
          providerCode: "model_output_limit_exceeded",
          reason: "model_output_limit_exceeded",
          source: "provider",
        },
        recoverable: true,
      },
    );
    const exhaustedErrorProjection = projectExecutionErrorPayload(
      exhaustedError,
      OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
    );
    completeOutputTokenRecovery(state.turnRequestState);
    await persistOutputTokenLimitErrorCarrier(this, state, {
      error: {
        name: exhaustedErrorProjection.code ?? exhaustedError.type,
        data: {
          ...(exhaustedErrorProjection.code ? { code: exhaustedErrorProjection.code } : {}),
          message: exhaustedErrorProjection.message,
          // 既有 cold hydration 用 retryable 恢复 UI recoverable；这里复用该字段，
          // 不为单一错误扩展 transcript/hydration schema。
          retryable: exhaustedError.recoverable,
          ...(exhaustedErrorProjection.attribution
            ? { attribution: exhaustedErrorProjection.attribution }
            : {}),
        },
      },
      finishReason: result.finishReason,
      model,
      modelTraceContext,
    });
    if (state.activeTurn) state.activeTurn.steerable = false;
    // 上游 query loop 会把 max_output_tokens API-error assistant 交给外层；这里复用
    // 既有 ModelError -> TurnError 收口表达同一实时错误，同时只结束当前 Turn command。
    throw exhaustedError;
  }
  completeOutputTokenRecovery(state.turnRequestState);
  if (executableToolCalls.length === 0) {
    return await finishModelStepWithoutToolCalls.call(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      modelTraceContext,
      result,
    });
  }

  state.toolCallCount += executableToolCalls.length;
  // 合并修复：工具调用 assistant 必须同时进入 canonical history 与本轮 request history。
  // 只写 canonical history 会让紧随其后的工具结果失去对应 assistant tool-call。
  if (commitAssistantToTurnRequest(this, state, result, executableToolCalls)) {
    recordModelHistoryRound(state);
  }
  const toolStepResult = await executeToolCallsForModelStep.call(this, state, {
    assistantCreatedAt,
    assistantMessageId,
    modelTraceContext,
    result,
    toolCalls: executableToolCalls,
    streamedToolResults,
  });
  return toolStepResult;
}
