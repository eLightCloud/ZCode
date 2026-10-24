import { beginLocalTurnPreparation } from "@zcode/contracts";
import { ensureGroupTaskPermissionScope } from "./input-intent-persistence.js";
import {
  HookEventName,
  TurnMachineImpl,
  createMessageId,
  runWithContextAsync,
  traceContextToLogContext,
} from "../deps.js";
import type { HookRunResult, MessageId, SessionGoal, TurnState } from "../deps.js";
import { isTurnCancellationError, throwIfTurnAborted } from "../helpers/index.js";
import type { ActiveTurnSteeringState, ExecuteTurnOptions, TurnResult } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runRegularTurnLoop } from "./turn-loop.js";
import { type RegularTurnLoopState } from "./turn-loop-state.js";
import { finishOutputTokenRecovery } from "./turn-output-token-continuation.js";
import {
  closeGoalStateChangeReminderDeferral,
  openGoalStateChangeReminderDeferral,
} from "./goal-state-reminder.js";
import { startProjectMemoryRecallPrefetch } from "../helpers/project-memory-recall.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import { applySubmissionExecutionState } from "./turn-model.js";
import { createTurnStartedEvent } from "./turn-start-event.js";
import { completeHookBlockedTurn } from "./turn-hook-completion.js";
import {
  injectDateChangeReminderIntoMessageHistory,
  injectReferencedSessionContextReminderIntoMessageHistory,
} from "./turn-context-reminders.js";
import { resolveAttachmentsAndSharedContext } from "./turn-attachment-context.js";
import { recordTurnUserInput } from "./turn-input-record.js";
import { completeRegularTurn } from "./turn-completion.js";
import { failRegularTurn } from "./turn-lifecycle-failure.js";
import { releaseRegularTurnResources } from "./turn-lifecycle-resources.js";
import { createAdmittedTurnModel } from "./turn-model-initialization.js";
import { prepareRegularTurnContext } from "./turn-context-initialization.js";
import { createRegularTurnLoopState } from "./turn-loop-initialization.js";
import { createTurnPhaseRecorder } from "./turn-phase-recorder.js";
import { beginRegularTurnScope } from "./turn-scope.js";

export const TARGET_RUN_HEARTBEAT_MS = 15_000;

export async function executeAdmittedTurnCommand(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
  startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  // 普通 Turn 过去在异步初始化完成后才读取 Session Selection/输出样式，
  // 初始化期间发生的切模会越过 admission 边界，错误影响已经开始的 Turn。
  // 这里在任何 await 之前冻结本轮事实；后续配置变化只作用于下一轮。
  const scope = beginRegularTurnScope.call(this, input, options, startReservation);
  options = scope.options;
  const {
    offPeakTurn,
    highspeedFallbackSelection,
    admittedModelSelection,
    admittedOutputStyle,
    compactInstructions,
    rewindCommand,
    turnId,
    queryId,
    displayInput,
    turnTraceContext,
    traceId,
    turnStartedAtMs,
    targetRunInputID,
    events,
    machineState,
    turnAbortScope,
    turnAbortSignal,
  } = scope;
  let activeTurn: ActiveTurnSteeringState | undefined;
  const targetState: { startedTarget: SessionGoal | null } = { startedTarget: null };
  let targetRunHeartbeat: ReturnType<typeof setInterval> | undefined;
  let userMessageId: MessageId | undefined;
  let loopState: RegularTurnLoopState | undefined;
  let shouldRetryTitleGenerationAfterTurn = false;
  // 线上“已工作 N 秒”但没有终态的根因候选是：内层 Turn try/catch 之前的 await
  // 拒绝直接穿出。记录当前阶段并区分是否已被内层处理，便于生产日志还原卡点。
  const phaseState: { turnPhase: string } = { turnPhase: "queued" };
  const failureState: { turnFailureHandled: boolean } = { turnFailureHandled: false };
  const { startTurnPhase, completeTurnPhase } = createTurnPhaseRecorder.call(
    this,
    turnTraceContext,
    phaseState,
  );
  const turnTelemetry = this.agentTelemetry.turn({
    inputSource: options?.inputSource,
    traceContext: turnTraceContext,
    turnNumber: this.turnNumber,
  });

  const execute = () =>
    runWithContextAsync(turnTraceContext, async () => {
      const executionStartedAt = performance.timeOrigin + performance.now();
      beginLocalTurnPreparation(turnTraceContext, "execution")();
      throwIfTurnAborted(turnAbortSignal);
      const modelPreparation = await createAdmittedTurnModel.call(
        this,
        rewindCommand,
        options,
        admittedModelSelection,
        failureState,
        turnAbortSignal,
        events,
        turnStartedAtMs,
        turnTraceContext,
        compactInstructions,
        highspeedFallbackSelection,
      );
      const { admittedModel, creationFailure } = modelPreparation;
      let phaseStartedAt: number;
      if (!creationFailure) {
        phaseStartedAt = startTurnPhase("context_initialization");
        phaseStartedAt = await prepareRegularTurnContext.call(
          this,
          admittedModel,
          turnTraceContext,
          completeTurnPhase,
          phaseStartedAt,
          turnAbortSignal,
          startTurnPhase,
        );
      }
      if (compactInstructions !== null) {
        const compactModel = await applySubmissionExecutionState(
          this,
          options?.intent,
          turnTraceContext,
          options?.modelExecution,
          admittedModel,
        );
        return this.executeManualCompact(
          input,
          compactInstructions,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
          compactModel,
        );
      }
      if (rewindCommand !== null) {
        return this.executeRewindCommand(
          input,
          rewindCommand,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
        );
      }
      // 创建失败轮不会进入 model step，guide 无法被消费；不可 steer 时调用方会改走队列。
      activeTurn = this.beginActiveTurn(
        turnId,
        turnTraceContext,
        "regular",
        creationFailure === undefined,
        {
          ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
        },
      );
      this.logger?.info("Turn started", {
        ...traceContextToLogContext(turnTraceContext),
        event: "turn.started",
        inputLength: input.length,
        module: "core.runtime",
        status: "started",
      });

      machineState.turnMachine = new TurnMachineImpl(machineState.turnMachine.start());
      phaseStartedAt = startTurnPhase("session_persistence");
      await this.ensureSessionPersisted(displayInput, turnTraceContext);
      await ensureGroupTaskPermissionScope(this.sessionStore, this.sessionId, options?.intent);
      // execution-scoped 临时 Provider（例如闲时任务）拥有本轮自己的模型，不改写
      // Session Selection；普通 Submission 才在真正开跑时应用其原子选择。
      // 创建失败轮不再应用：重复建模会在主 try 之外再次抛错；也不改写选择、mode、plan，
      // 不占用目标轮次。
      const submissionModel = creationFailure
        ? undefined
        : await applySubmissionExecutionState(
            this,
            options?.intent,
            turnTraceContext,
            options?.modelExecution,
            admittedModel,
          );
      targetState.startedTarget = creationFailure
        ? null
        : await this.readSessionTargetForContext(turnTraceContext);
      completeTurnPhase("target_read", phaseStartedAt);
      if (targetState.startedTarget?.status !== "active") {
        targetState.startedTarget = null;
      }
      userMessageId =
        options?.skipInputRecord === true
          ? (options.recordedInputMessageId ?? createMessageId())
          : createMessageId();
      // 附件展示元信息随 TurnStarted 下发（v4 投影 → userInput row.attachments）。
      // workspace checkpoint 挂在 user messageId 上；先生成 id 再发 TurnStarted，
      // v4 投影才能用 turn rowId 找回该轮文件 checkpoint，避免摘要有计数但展开查空。
      const turnStartedEvent = createTurnStartedEvent.call(
        this,
        attachments,
        executionStartedAt,
        displayInput,
        userMessageId,
        options,
        queryId,
        turnTraceContext,
      );
      phaseStartedAt = startTurnPhase("turn_started_event");
      await this.appendEvent(turnStartedEvent, turnTraceContext);
      completeTurnPhase("turn_started_event", phaseStartedAt);
      events.push(turnStartedEvent);
      phaseStartedAt = startTurnPhase("target_accounting");
      targetState.startedTarget = await this.startTargetTurnAccounting({
        inputID: targetRunInputID,
        startedAtMs: turnStartedAtMs,
        startedTarget: targetState.startedTarget,
        traceContext: turnTraceContext,
      });
      completeTurnPhase("target_accounting", phaseStartedAt);
      if (targetState.startedTarget && this.sessionStore?.heartbeatTargetRun) {
        targetRunHeartbeat = setInterval(() => {
          void this.trackResidencyBlockingWork(
            this.heartbeatTargetTurnAccounting({
              inputID: targetRunInputID,
              seenAtMs: Date.now(),
              startedTarget: targetState.startedTarget,
              traceContext: turnTraceContext,
            }),
          );
        }, TARGET_RUN_HEARTBEAT_MS);
        if (typeof targetRunHeartbeat === "object" && "unref" in targetRunHeartbeat) {
          targetRunHeartbeat.unref();
        }
      }

      try {
        phaseStartedAt = startTurnPhase("user_prompt_hooks");
        const userPromptHookResult: HookRunResult = options?.skipUserPromptSubmitHooks
          ? { additionalContexts: [] }
          : await this.runUserPromptSubmitHooks(
              input,
              attachments,
              turnTraceContext,
              turnAbortSignal,
            );
        completeTurnPhase("user_prompt_hooks", phaseStartedAt);
        if (userPromptHookResult.preventContinuation) {
          return await completeHookBlockedTurn.call(
            this,
            userPromptHookResult,
            activeTurn,
            machineState,
            events,
            options,
            turnTraceContext,
            turnStartedAtMs,
            turnId,
            targetRunInputID,
            targetState.startedTarget,
            traceId,
          );
        }
        this.injectHookAdditionalContextIntoMessageHistory(
          HookEventName.UserPromptSubmit,
          userPromptHookResult.additionalContexts,
        );
        injectReferencedSessionContextReminderIntoMessageHistory.call(this, input, options);
        // 话题原文由标准文本附件按需读取，可信来源归档不能再次生成隐藏上下文。
        injectDateChangeReminderIntoMessageHistory.call(this);
        const resolvedAttachments = await resolveAttachmentsAndSharedContext.call(
          this,
          attachments,
          turnAbortSignal,
          turnTraceContext,
          turnId,
          options,
        );
        shouldRetryTitleGenerationAfterTurn = await recordTurnUserInput.call(
          this,
          turnTraceContext,
          options,
          input,
          resolvedAttachments,
          userMessageId,
          displayInput,
          turnAbortSignal,
          shouldRetryTitleGenerationAfterTurn,
          modelPreparation,
          events,
        );

        this.messageHistory.setCacheMiss();
        const loopModel = submissionModel ?? admittedModel;
        if (!loopModel) {
          throw new Error("Turn model was not created before execution");
        }
        startProjectMemoryRecallPrefetch(
          this,
          {
            model: loopModel,
            traceContext: turnTraceContext,
            turnAbortSignal,
          },
          ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
        );
        loopState = createRegularTurnLoopState.call(
          this,
          loopState,
          activeTurn,
          options,
          userMessageId,
          events,
          input,
          loopModel,
          traceId,
          turnAbortSignal,
          turnId,
          machineState,
          admittedOutputStyle,
          turnTraceContext,
          modelPreparation,
          highspeedFallbackSelection,
        );

        openGoalStateChangeReminderDeferral(activeTurn);
        phaseStartedAt = startTurnPhase("regular_turn_loop");
        try {
          await runRegularTurnLoop.call(this, loopState);
          completeTurnPhase("regular_turn_loop", phaseStartedAt);
        } finally {
          finishOutputTokenRecovery(loopState.turnRequestState);
          await closeGoalStateChangeReminderDeferral.call(this, activeTurn, turnTraceContext);
        }
        machineState.turnMachine = loopState.turnMachine;

        return await completeRegularTurn.call(
          this,
          events,
          targetRunInputID,
          turnStartedAtMs,
          targetState.startedTarget,
          turnTraceContext,
          loopState,
          machineState.turnMachine,
          options,
          turnId,
          userMessageId,
          shouldRetryTitleGenerationAfterTurn,
          displayInput,
          traceId,
        );
      } catch (error) {
        failureState.turnFailureHandled = true;
        return await failRegularTurn.call(
          this,
          error,
          turnAbortSignal,
          targetRunInputID,
          targetState,
          turnTraceContext,
          activeTurn,
          events,
          options,
          loopState,
          machineState.turnMachine,
          turnStartedAtMs,
          turnId,
          userMessageId,
          modelPreparation,
        );
      }
    }).then(
      (result) => {
        turnTelemetry.finishCompleted("assistant_message");
        return result;
      },
      (error: unknown) => {
        if (!failureState.turnFailureHandled) {
          this.logger?.warn("Turn execution escaped lifecycle handler", {
            ...traceContextToLogContext(turnTraceContext),
            durationMs: Date.now() - turnStartedAtMs,
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "turn.lifecycle.unhandled_rejection",
            module: "core.runtime",
            phase: phaseState.turnPhase,
            status: "failed",
          });
        }
        if (isTurnCancellationError(error, turnAbortSignal)) {
          turnTelemetry.finishCancelled("abort_signal");
        } else {
          turnTelemetry.finishFailed("unhandled", "unknown", error);
        }
        throw error;
      },
    );

  return turnTelemetry.run(execute).finally(async () => {
    await releaseRegularTurnResources.call(
      this,
      targetRunHeartbeat,
      turnId,
      activeTurn,
      turnAbortScope,
      turnTraceContext,
      offPeakTurn,
      turnAbortSignal,
      events,
    );
  });
}
