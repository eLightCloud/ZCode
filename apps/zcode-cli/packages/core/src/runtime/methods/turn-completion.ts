import {
  SessionEventType,
  TurnMachineImpl,
  createModelUsageSummaryFromEvents,
  traceContextToLogContext,
} from "../deps.js";

import type {
  MessageId,
  SessionEvent,
  SessionGoal,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";

import type { ExecuteTurnOptions, TurnResult } from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { maybeStartDeferredSessionTitleGeneration } from "./session-title.js";

import { type RegularTurnLoopState } from "./turn-loop-state.js";

import { recordTurnUsageFact } from "./usage-observability.js";

import { persistStableForkCompletionBoundary } from "./stable-fork-boundary.js";

import { scheduleProjectMemoryExtraction } from "../helpers/project-memory-extraction.js";

import { appendBrowserTurnScreenshot } from "./browser-turn-screenshot.js";

export async function completeRegularTurn(
  this: AgentRuntimeInternal,
  events: SessionEvent[],
  targetRunInputID: string,
  turnStartedAtMs: number,
  startedTarget: SessionGoal | null,
  turnTraceContext: TraceContext,
  loopState: RegularTurnLoopState,
  turnMachine: TurnMachineImpl,
  options: ExecuteTurnOptions | undefined,
  turnId: TurnId,
  userMessageId: MessageId | undefined,
  shouldRetryTitleGenerationAfterTurn: boolean,
  displayInput: string,
  traceId: TraceId,
) {
  const turnUsage = createModelUsageSummaryFromEvents(events);
  // goal usage/active-run 先结算，再固定 exact goal/verifier boundary；只有两者都
  // 已持久化，TurnComplete 才能让 projection/UI 开放最终 assistant fork。
  await this.accountTargetTurnCompletion({
    inputID: targetRunInputID,
    startedAtMs: turnStartedAtMs,
    startedTarget,
    traceContext: turnTraceContext,
    usage: turnUsage,
  });
  if (loopState.stableProductStartMessageId && loopState.stableBoundaryAssistantMessageId) {
    await persistStableForkCompletionBoundary(this, {
      boundaryMessageId: loopState.stableBoundaryAssistantMessageId,
      startMessageId: loopState.stableProductStartMessageId,
      historyRoundCount: loopState.historyRoundCount,
      traceContext: turnTraceContext,
    });
  }
  if (loopState.stableBoundaryAssistantMessageId) {
    await appendBrowserTurnScreenshot(this, loopState, loopState.stableBoundaryAssistantMessageId);
  }
  const completeEvent = this.createEvent(
    SessionEventType.TurnComplete,
    {
      response: loopState.modelResponse,
      tokenCount: loopState.tokenCount,
      usage: turnUsage,
      toolCallCount: loopState.toolCallCount,
      historyRoundCount: loopState.historyRoundCount,
      duration: Date.now() - turnMachine.state.startedAt.getTime(),
      resultType: "success",
      ...(loopState.backgroundSubagentResultConsumed
        ? { backgroundSubagentResultConsumed: true }
        : {}),
      ...(loopState.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
      cacheStats: this.messageHistory.getCacheStats(),
      inputId: options?.inputId,
    },
    turnTraceContext,
  );
  await this.appendEvent(completeEvent, turnTraceContext);
  events.push(completeEvent);
  await recordTurnUsageFact(this, {
    completedAt: Date.now(),
    events,
    startedAt: turnStartedAtMs,
    status: "completed",
    traceContext: turnTraceContext,
    turnId,
    userMessageId,
  });
  if (shouldRetryTitleGenerationAfterTurn && userMessageId) {
    // 需要请求前刷新 provider runtime headers 的模型
    // 若在主 turn 前生成标题，会先占用鉴权刷新窗口，导致真正的用户消息失败。
    maybeStartDeferredSessionTitleGeneration.call(
      this,
      displayInput,
      userMessageId,
      turnTraceContext,
    );
  }
  this.turnNumber++;

  const projection = await this.rebuildProjection();
  this.logger?.info("Turn completed", {
    ...traceContextToLogContext(turnTraceContext),
    durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
    event: "turn.completed",
    module: "core.runtime",
    status: "completed",
    toolCallCount: loopState.toolCallCount,
  });
  // 单轮执行策略只抑制本次成功 Turn 的后台提取，不修改 Session Memory 配置。
  if (options?.modelExecution?.memoryExtraction !== "skip") {
    scheduleProjectMemoryExtraction(this, {
      model: loopState.model,
      traceContext: turnTraceContext,
    });
  }

  const result: TurnResult = {
    response: loopState.modelResponse,
    turnId,
    traceId,
    usage: turnUsage,
    events,
    projection,
  };
  return result;
}
