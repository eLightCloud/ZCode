import {
  MODEL_CREATION_FAILED_MESSAGE,
  MODEL_CREATION_TURN_PHASE,
} from "./turn-model-initialization.js";
const TURN_EXECUTION_FAILED_MESSAGE = "Turn execution failed";
import type { createAdmittedTurnModel } from "./turn-model-initialization.js";
import { CoreErrorType } from "../deps.js";
import { TurnMachineImpl } from "../deps.js";
import type { MessageId } from "../deps.js";
import type { SessionEvent } from "../deps.js";
import type { SessionGoal } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { TurnId } from "../deps.js";
import { appendTurnOutcomeEvent } from "../helpers/index.js";
import { createTurnFailureError } from "../helpers/index.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { ExecuteTurnOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import { traceContextToLogContext } from "../deps.js";
import { isTurnCancellationError } from "../helpers/index.js";

export async function failRegularTurn(
  this: AgentRuntimeInternal,
  error: unknown,
  turnAbortSignal: AbortSignal,
  targetRunInputID: string,
  targetState: { startedTarget: SessionGoal | null },
  turnTraceContext: TraceContext,
  activeTurn: ActiveTurnSteeringState,
  events: SessionEvent[],
  options: ExecuteTurnOptions | undefined,
  loopState: RegularTurnLoopState | undefined,
  turnMachine: TurnMachineImpl,
  turnStartedAtMs: number,
  turnId: TurnId,
  userMessageId: MessageId | undefined,
  modelPreparation: Awaited<ReturnType<typeof createAdmittedTurnModel>>,
): Promise<never> {
  const { creationFailure, creationFallbackUnavailable } = modelPreparation;
  // CR-01：创建失败轮进入主链只为保留已接纳输入。落库中的普通失败不能覆盖模型创建错误，
  // 只记 warn。用户取消仍收口为 cancelled；宿主 fault 只经 abort signal 传入，
  // createTurnFailureError 会先于创建错误识别它。
  const reportedCreationFailure =
    creationFailure && !isTurnCancellationError(error, turnAbortSignal)
      ? creationFailure
      : undefined;
  if (reportedCreationFailure && error !== reportedCreationFailure.error) {
    this.logger?.warn("Accepted input persistence failed after model creation failed", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "turn.model_creation.input_persistence_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
  const fallbackMessage = reportedCreationFailure
    ? MODEL_CREATION_FAILED_MESSAGE
    : TURN_EXECUTION_FAILED_MESSAGE;
  const coreError = createTurnFailureError(
    reportedCreationFailure ? reportedCreationFailure.error : error,
    turnAbortSignal,
    fallbackMessage,
  );
  const preserveQueueAutoDrainOnCancel =
    coreError.type === CoreErrorType.TurnCancelled &&
    this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
  const finishedTarget = await this.finishTargetTurnAccounting({
    endedAtMs: Date.now(),
    inputID: targetRunInputID,
    startedTarget: targetState.startedTarget,
    status: coreError.type === CoreErrorType.TurnCancelled ? "paused" : undefined,
    traceContext: turnTraceContext,
  });
  if (finishedTarget?.targetID === targetState.startedTarget?.targetID) {
    targetState.startedTarget = finishedTarget;
  }
  if (coreError.type === CoreErrorType.TurnCancelled) {
    await this.pauseActiveTargetForCancellation(turnTraceContext);
    if (activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn,
        events,
        reasonCode: "guide.turnInterrupted",
        traceContext: turnTraceContext,
      });
    }
  }
  // 普通 TurnError 只结束当前 turn，不撤销已经 accepted 的 future input。
  // V4 TurnError 投影将队列切成 error-paused，runtime 同步关闭行内 drain，
  // 保留排队输入，等待用户显式继续。
  if (activeTurn && coreError.type !== CoreErrorType.TurnCancelled) {
    const pendingInputs = (await this.rebuildProjection()).pendingSteerInputs;
    if (pendingInputs.length > 0) {
      this.queueAutoDrain = false;
      this.queueExternalDrainActive = false;
    }
  } else if (
    activeTurn &&
    coreError.type === CoreErrorType.TurnCancelled &&
    !preserveQueueAutoDrainOnCancel &&
    activeTurn.pendingInputs.length > 0
  ) {
    // runtime 授权位与投影同步：投影在 TurnComplete(cancelled)+queue>0 时把
    // queue.autoDrain 置 false（held），runtime 的 drain 门也必须同步翻转，
    // 否则 held 期间新起的 turn 会把后续入队项 drain 掉，与投影语义分叉。
    this.queueAutoDrain = false;
    this.queueExternalDrainActive = false;
  }

  // background wake 可能在 loopState 初始化前取消；此时仍要保留已 dequeue 的结果事实。
  const backgroundSubagentResultConsumed =
    options?.backgroundSubagentResultConsumed === true ||
    loopState?.backgroundSubagentResultConsumed === true;
  const workflowResultConsumed =
    options?.workflowResultConsumed === true || loopState?.workflowResultConsumed === true;
  await appendTurnOutcomeEvent(this, {
    coreError,
    events,
    durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
    turnPhase: reportedCreationFailure ? MODEL_CREATION_TURN_PHASE : turnMachine.state.phase,
    inputId: options?.inputId,
    highspeedCardId: options?.intent?.highspeed?.cardId,
    highspeedFallbackUnavailable:
      creationFallbackUnavailable || loopState?.highspeedFallbackUnavailable === true,
    traceContext: turnTraceContext,
    fallbackMessage,
    logEvent: "turn.failed",
    logLabel: "Turn",
    preserveQueueAutoDrainOnCancel,
    backgroundSubagentResultConsumed,
    workflowResultConsumed,
    historyRoundCount: loopState?.historyRoundCount,
  });
  await recordTurnUsageFact(this, {
    completedAt: Date.now(),
    error: coreError,
    events,
    startedAt: turnStartedAtMs,
    status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
    traceContext: turnTraceContext,
    turnId,
    userMessageId,
  });
  throw coreError;
}
