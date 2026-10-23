import { SessionEventType, TurnMachineImpl, createModelUsageSummaryFromEvents } from "../deps.js";

import type {
  HookRunResult,
  SessionEvent,
  SessionGoal,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";

import type { ActiveTurnSteeringState, ExecuteTurnOptions } from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { recordTurnUsageFact } from "./usage-observability.js";

export async function completeHookBlockedTurn(
  this: AgentRuntimeInternal,
  userPromptHookResult: HookRunResult,
  activeTurn: ActiveTurnSteeringState,
  machineState: { turnMachine: TurnMachineImpl },
  events: SessionEvent[],
  options: ExecuteTurnOptions | undefined,
  turnTraceContext: TraceContext,
  turnStartedAtMs: number,
  turnId: TurnId,
  targetRunInputID: string,
  startedTarget: SessionGoal | null,
  traceId: TraceId,
) {
  const response = userPromptHookResult.stopReason ?? "Prompt blocked by UserPromptSubmit hook.";
  if (activeTurn) activeTurn.steerable = false;
  machineState.turnMachine = new TurnMachineImpl(
    machineState.turnMachine.complete(response, "success"),
  );
  const turnUsage = createModelUsageSummaryFromEvents(events);
  const completeEvent = this.createEvent(
    SessionEventType.TurnComplete,
    {
      response,
      tokenCount: 0,
      usage: turnUsage,
      toolCallCount: 0,
      duration: Date.now() - machineState.turnMachine.state.startedAt.getTime(),
      resultType: "success",
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
  });
  this.turnNumber++;
  const projection = await this.rebuildProjection();
  await this.accountTargetTurnCompletion({
    inputID: targetRunInputID,
    startedAtMs: turnStartedAtMs,
    startedTarget,
    traceContext: turnTraceContext,
    usage: turnUsage,
  });
  return {
    response,
    turnId,
    traceId,
    usage: turnUsage,
    events,
    projection,
  };
}
