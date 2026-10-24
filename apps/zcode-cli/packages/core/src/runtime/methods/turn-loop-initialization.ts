import type { createAdmittedTurnModel } from "./turn-model-initialization.js";
import { TurnMachineImpl } from "../deps.js";

import type {
  MessageId,
  Model,
  OutputStylePromptConfig,
  SessionEvent,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";

import type { ActiveTurnSteeringState, ExecuteTurnOptions } from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { type RegularTurnLoopState } from "./turn-loop-state.js";

export function createRegularTurnLoopState(
  this: AgentRuntimeInternal,
  loopState: RegularTurnLoopState | undefined,
  activeTurn: ActiveTurnSteeringState | undefined,
  options: ExecuteTurnOptions | undefined,
  userMessageId: MessageId,
  events: SessionEvent[],
  input: string,
  loopModel: Model,
  traceId: TraceId,
  turnAbortSignal: AbortSignal,
  turnId: TurnId,
  machineState: { turnMachine: TurnMachineImpl },
  admittedOutputStyle: OutputStylePromptConfig | undefined,
  turnTraceContext: TraceContext,
  modelPreparation: Awaited<ReturnType<typeof createAdmittedTurnModel>>,
  highspeedFallbackSelection: ReturnType<AgentRuntimeInternal["getSessionModelSelection"]>,
) {
  const { creationFallback, effectiveExecutionSelection, effectiveRequestDependencies } =
    modelPreparation;
  loopState = {
    activeTurn,
    ...(options?.automationId ? { automationId: options.automationId } : {}),
    // 闲时派发轮的身份进入 loop state，供工具执行边界 deny OffPeakCreate。
    ...(options?.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
    ...(options?.offPeakExecutionId ? { offPeakExecutionId: options.offPeakExecutionId } : {}),
    anomalyWarningsInjected: 0,
    backgroundSubagentResultConsumed: options?.backgroundSubagentResultConsumed === true,
    workflowResultConsumed: options?.workflowResultConsumed === true,
    completedRealToolResultBatch: false,
    currentUserMessageId: userMessageId,
    events,
    input,
    ...(options?.inputId ? { inputId: options.inputId } : {}),
    modelResponse: "",
    model: loopModel,
    ...(options?.modelExecution?.selectionScope === "execution"
      ? { modelSelectionScope: "execution" as const }
      : {}),
    // 加速卡回退仅使用启动时快照，不随随后接纳的用户选择变化。
    ...(!creationFallback && options?.modelExecution?.selectionFallback
      ? {
          selectionFallback: options.modelExecution.selectionFallback,
          highspeedFallbackSelection,
        }
      : {}),
    ...(options?.modelExecution?.subagents && effectiveExecutionSelection
      ? {
          subagentModelOverride: {
            selection: effectiveExecutionSelection,
            requestDependencies: effectiveRequestDependencies,
            background: options.modelExecution.subagents.background,
          },
        }
      : {}),
    modelStepCount: 0,
    historyRoundCount: 0,
    reactiveCompactAttemptedInCurrentModelStep: false,
    repeatedToolCallSignature: undefined,
    repeatedToolCallStreakCount: 0,
    stopHookContinuationCount: 0,
    streamRecoveryRetryCount: 0,
    tokenCount: 0,
    toolCallCount: 0,
    turnRequestState: {
      // Turn 只借一次 canonical 成员集合，之后由显式 commit 推进；entry 本身
      // 遵循 MessageHistory 的不可变约定。
      entries: [...this.messageHistory.borrowReadOnlyRuntimeEntries()],
      outputTokenContinuationCount: 0,
    },
    toolDisallowlist: options?.toolDisallowlist,
    traceId,
    turnAbortSignal,
    turnId,
    turnMachine: machineState.turnMachine,
    turnOutputStyle: admittedOutputStyle,
    turnTraceContext,
    userMessageId,
  };
  return loopState;
}
