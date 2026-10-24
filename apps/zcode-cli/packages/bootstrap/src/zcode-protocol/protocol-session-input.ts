import { isReadonlyAgentSessionKind, OFF_PEAK_EXECUTION_TOOL_DENYLIST } from "@zcode/shared";
import { inputIntentMetadata } from "../zcode-protocol-v4/commands/input-intent.js";
import { createModelExecutionContext } from "./model-execution.js";
import type { SendInputOptions } from "../app/app-option-types.js";
import { type QueryId, type TurnBackgroundAttribution } from "@zcode/contracts";
import {
  zcodeSessionCancelBackgroundTaskParamsSchema,
  zcodeSessionCompactParamsSchema,
  zcodeSessionSendParamsSchema,
  zcodeSessionStopParamsSchema,
  type ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import {
  ProtocolRequestError,
  assertExpectedRevision,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { runWithSessionResidencyFinalization } from "./session-residency.js";
import {
  assertExpectedProviderRevision,
  ensureSessionModelAvailableForNextTurn,
} from "./protocol-session-model.js";
import {
  afterPromptAccepted,
  emitStateUpdated,
  afterStateMutation,
} from "./protocol-state-notifications.js";
import { snapshot } from "./protocol-session-snapshot.js";
import { ensureNoActiveTurn, type ProtocolGoalTarget } from "./protocol-session-goal.js";
import { mapProtocolPromptAttachments } from "./protocol-input-attachments.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
export async function sendPrompt(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSendParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  // legacy 输入入口同样必须保持子代理只读，不能绕过 V4 用户输入准入。
  if (isReadonlyAgentSessionKind(record.taskType)) {
    throw new ProtocolRequestError(-32010, "Subagent sessions are read-only", {
      reasonCode: "guard.subagentReadOnly",
    });
  }
  assertExpectedRevision(record, params.expectedRevision);
  assertExpectedProviderRevision(context, record, params.expectedProviderRevision);
  if (record.activeAbortController) {
    context.logger?.warn("ZCode Protocol session/send rejected: active prompt exists", {
      inputId: params.inputId,
      queryId: params.queryId,
      sessionId: params.sessionId,
      textLength: params.content.length,
      workspacePath: record.workspace.workspacePath,
    });
    throw new ProtocolRequestError(-32010, "A prompt is already running for this session");
  }
  if (record.restoreWarning) {
    throw new ProtocolRequestError(-32031, record.restoreWarning.message, {
      code: record.restoreWarning.type,
      sessionId: record.app.sessionId,
      workspace: record.workspace,
    });
  }
  await ensureSessionModelAvailableForNextTurn(context, record);
  if (record.persistence === "deferred") {
    // 未发送前的 draft session 不进入两份 sqlite；用户真正发送首条消息时，
    // 才把它提升为普通 session，让后续 list/syncer/task index 按真实任务处理。
    record.persistence = "immediate";
  }
  const abortController = new AbortController();
  record.activeAbortController = abortController;
  context.logger?.info("ZCode Protocol session/send accepted", {
    attachmentCount: params.attachments?.length ?? 0,
    inputId: params.inputId,
    queryId: params.queryId,
    sessionId: params.sessionId,
    textLength: params.content.length,
    workspacePath: record.workspace.workspacePath,
  });
  const inputId = params.inputId ?? (params.modelSelection ? crypto.randomUUID() : undefined);
  // 旧附件载荷也经同一个 canonical intent 固定本次选择，不先改 Session。这里只借用
  // 公共 metadata 构造器（非 V4 ACK/重放入口）；无 V4 admission 的序号沿既有值 0。
  const intent =
    params.modelSelection && inputId
      ? inputIntentMetadata(
          {
            commandId: inputId,
            clientId: "legacy-session-send",
            sessionId: params.sessionId,
            type: "sendText",
            payload: {},
            issuedAt: Date.now(),
          },
          {
            text: params.content,
            requestedDelivery: "startNow",
            modelSelection: params.modelSelection,
          },
        )
      : undefined;
  void runWithSessionResidencyFinalization(record, () =>
    runPromptTurnInBackground(context, record, {
      abortController,
      attachments: params.attachments,
      browserAmbientContext: params.browserAmbientContext,
      inputId,
      intent,
      modelExecution: params.modelExecution
        ? createModelExecutionContext(params.modelExecution)
        : undefined,
      queryId: (params.queryId ?? inputId) as QueryId | undefined,
      content: params.content,
      ...(params.automationId
        ? { automationId: params.automationId }
        : params.offPeakTaskId
          ? {
              offPeakTaskId: params.offPeakTaskId,
              ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
            }
          : {}),
      toolDenylist: params.toolDenylist,
      botDeliveryTarget: params.botDeliveryTarget,
    }),
  ).catch(() => {
    // 后台 turn 的错误会通过状态/事件流降级上报；这里兜底防止协议进程出现 unhandled rejection。
  });
  // session/send 只是“提交用户输入”的协议请求，不能同步等待整轮模型生成完成。
  // 同步等待首 token/整轮会让超过 30s 的请求触发 host timeout，并且阻塞后续 session/resume、list 等协议消息。
  // 这里收到输入后立即 ACK，后台 turn 继续通过 session event/state.updated 推送进度。
  return afterPromptAccepted(context, record, "prompt_started");
}

export async function compactSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionCompactParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  const activeTurn = record.app.runtime.getActiveTurnInfo();
  if (activeTurn?.kind === "compact") {
    // 重复 `/compact` 是同一 session 的上下文维护请求；压缩中再收到时应直接丢弃，
    // 不能进入普通 prompt/steer 队列，也不能渲染成一次失败的压缩横条。
    return {
      response: "",
      snapshot: await snapshot(context, record, undefined, {
        modelAvailability: "current",
      }),
      compact: {
        state: "already_running" as const,
        ...(params.inputId ? { inputId: params.inputId } : {}),
      },
    };
  }
  ensureNoActiveTurn(record, "Cannot compact while a prompt is running");
  if (record.restoreWarning) {
    throw new ProtocolRequestError(-32031, record.restoreWarning.message, {
      code: record.restoreWarning.type,
      sessionId: record.app.sessionId,
      workspace: record.workspace,
    });
  }
  await ensureSessionModelAvailableForNextTurn(context, record);
  const instructions = params.instructions?.trim();
  const command = instructions ? `/compact ${instructions}` : "/compact";
  const abortController = new AbortController();
  // compact 的真实模型请求在后台执行，但 Stop 仍通过 record.activeAbortController 中断。
  // 如果这里不登记 controller，压缩中的模型请求会继续跑到自然结束。
  record.activeAbortController = abortController;
  void runWithSessionResidencyFinalization(record, () =>
    runCompactTurnInBackground(context, record, {
      abortController,
      command,
      inputId: params.inputId,
    }),
  ).catch(() => {
    // 后台 compact 的错误会通过 compact timeline/state.updated 降级上报；这里兜底防 unhandled rejection。
  });
  record.stateRevision++;
  record.updatedAt = Date.now();
  const acceptedSnapshot = await snapshot(context, record, undefined, {
    modelAvailability: "current",
  });
  emitStateUpdated(context, record, "compact_started", { status: "running" });
  return {
    response: "",
    snapshot: acceptedSnapshot,
    compact: {
      state: "accepted" as const,
      ...(params.inputId ? { inputId: params.inputId } : {}),
    },
  };
}

async function runCompactTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    command: string;
    inputId?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  context.logger?.info("ZCode Protocol background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt(params.command, {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
    context.logger?.info("ZCode Protocol background compact completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = params.abortController.signal.aborted
      ? "session_compact_cancelled"
      : "session_compact_failed";
    context.logger?.warn("ZCode Protocol background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (record.activeAbortController === params.abortController) {
      // compact 结束后必须先释放 active lock 再广播状态；否则 queued prompt
      // 或后续 `/compact` 会在 ready 边界短暂撞上旧 controller。
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

async function runPromptTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    intent?: SendInputOptions["intent"];
    modelExecution?: SendInputOptions["modelExecution"];
    attachments?: unknown[];
    browserAmbientContext?: {
      tabCount: number;
      currentUrl?: string;
    };
    inputId?: string;
    queryId?: QueryId;
    content: string;
    toolDenylist?: readonly string[];
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  } & TurnBackgroundAttribution,
): Promise<void> {
  const startedAt = Date.now();
  context.logger?.info("ZCode Protocol background turn started", {
    inputId: params.inputId,
    queryId: params.queryId,
    sessionId: record.app.sessionId,
    textLength: params.content.length,
    workspacePath: record.workspace.workspacePath,
  });
  let mutationReason = "prompt_completed";
  const previousAutomationId = record.activeAutomationId;
  const previousOffPeakTaskId = record.activeOffPeakTaskId;
  const previousBotDeliveryTarget = record.activeBotDeliveryTarget;
  const activeAutomationId = resolvePromptTurnAutomationId(params);
  const activeOffPeakTaskId = resolvePromptTurnOffPeakTaskId(params);
  const turnToolDisallowlist = buildPromptTurnToolDisallowlist(
    params,
    activeAutomationId,
    activeOffPeakTaskId,
  );
  if (activeAutomationId) {
    // 附件输入仍走旧 session/send；automation 派发可能漏传 automationId，
    // 但 inputId 会保留 automation-* runId。这里兜底标记，避免 CronCreate 在绑定 active
    // 会话里递归创建定时任务。
    record.activeAutomationId = activeAutomationId;
  }
  if (activeOffPeakTaskId) {
    // 闲时派发轮同型兜底标记，供 offpeak-port 拒绝递归 OffPeakCreate。
    record.activeOffPeakTaskId = activeOffPeakTaskId;
  }
  record.activeBotDeliveryTarget = params.botDeliveryTarget;
  try {
    const admission = await record.app.sendInput(
      {
        attachments: mapProtocolPromptAttachments(params.attachments),
        text: params.content,
      },
      {
        abortSignal: params.abortController.signal,
        intent: params.intent,
        modelExecution: params.modelExecution,
        browserAmbientContext: params.browserAmbientContext,
        inputId: params.inputId,
        queryId: params.queryId,
        ...(params.automationId
          ? { automationId: params.automationId }
          : params.offPeakTaskId
            ? {
                offPeakTaskId: params.offPeakTaskId,
                ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
              }
            : {}),
        // legacy session/send 同样可能复用 active runtime；只做 port 拒绝时模型仍看得到
        // CronCreate，并可能在失败后改调 CronDelete。automation turn 与 cron task 会话后续输入
        // 都直接从本轮 provider 工具面移除。
        ...(turnToolDisallowlist ? { toolDisallowlist: turnToolDisallowlist } : {}),
      },
    );
    // admission 不是整轮结束。提前清理会丢失 automation 归属及 Stop controller；
    // ACK 已由 session/send 返回，后台只在真实 completion 后释放本轮资源。
    if (admission.kind === "rejected") {
      throw new ProtocolRequestError(-32010, `Prompt admission rejected: ${admission.reason}`);
    }
    if (admission.kind === "started_turn") await admission.completion;
    context.logger?.info("ZCode Protocol background turn completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      queryId: params.queryId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = "prompt_failed";
    context.logger?.warn("ZCode Protocol background turn failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (record.activeAbortController === params.abortController) {
      // prompt_completed/prompt_failed 是下游 host queue 的 ready 边界。
      // 必须先释放 active lock 再广播状态，否则手机端收到 ready 后立刻 drain 会被
      // session/send 拒绝为 "A prompt is already running for this session"。
      record.activeAbortController = undefined;
      context.logger?.info("ZCode Protocol background turn cleared active controller", {
        durationMs: Date.now() - startedAt,
        inputId: params.inputId,
        sessionId: record.app.sessionId,
        workspacePath: record.workspace.workspacePath,
      });
    }
    record.activeAutomationId = previousAutomationId;
    record.activeOffPeakTaskId = previousOffPeakTaskId;
    // Bug 原因：legacy record 会跨 turn 复用；必须恢复 Bot 地址，避免后续普通 UI turn
    // 创建的定时任务错误继承上一轮 Bot 会话。
    record.activeBotDeliveryTarget = previousBotDeliveryTarget;
  }
  await afterStateMutation(context, record, mutationReason);
}

function buildPromptTurnToolDisallowlist(
  params: {
    automationId?: string;
    offPeakTaskId?: string;
    inputId?: string;
    toolDenylist?: readonly string[];
  },
  activeAutomationId = params.automationId,
  activeOffPeakTaskId = params.offPeakTaskId,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (activeAutomationId) tools.add("CronCreate");
  // 闲时派发轮隐藏 OffPeakCreate（防递归自我派生）；OffPeakList 只读保留。
  // 注意 automation 轮不加 OffPeakCreate——cron 轮放行（定时派生闲时任务）。
  // SendMessage / Workflow 同样隐藏，与 V4 prompt-turn 及 core turn-loop-state 同值。
  if (activeOffPeakTaskId) {
    for (const toolName of OFF_PEAK_EXECUTION_TOOL_DENYLIST) tools.add(toolName);
  }
  return tools.size > 0 ? [...tools] : undefined;
}

function resolvePromptTurnAutomationId(params: {
  automationId?: string;
  inputId?: string;
}): string | undefined {
  const explicit = params.automationId?.trim();
  if (explicit) return explicit;
  const inputId = params.inputId?.trim();
  if (!inputId?.startsWith("automation-")) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const automationId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return automationId.length > "automation-".length ? automationId : undefined;
}

function resolvePromptTurnOffPeakTaskId(params: {
  offPeakTaskId?: string;
  inputId?: string;
}): string | undefined {
  const explicit = params.offPeakTaskId?.trim();
  if (explicit) return explicit;
  // 兜底：续跑派发的 inputId 形如 `offpeak-<uuid>:resume:<uuid>`（首段 traceId 无固定前缀，
  // 主信号必须是显式 offPeakTaskId）。
  const inputId = params.inputId?.trim();
  if (!inputId?.startsWith("offpeak-")) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const offPeakTaskId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return offPeakTaskId.length > "offpeak-".length ? offPeakTaskId : undefined;
}

export async function stopSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionStopParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const hadActivePrompt = Boolean(record.activeAbortController);
  let pausedTarget: ProtocolGoalTarget | null = null;
  context.logger?.info("ZCode Protocol session/stop received", {
    hadActivePrompt,
    sessionId: params.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  if (hadActivePrompt) {
    pausedTarget = await pauseActiveGoalForSessionStop(context, record, {
      sessionId: params.sessionId,
    });
  }
  record.activeAbortController?.abort(new Error("ZCode Protocol session stopped"));
  if (pausedTarget) {
    await afterStateMutation(context, record, "session_stop_goal_paused");
  }
  return {};
}

async function pauseActiveGoalForSessionStop(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: { sessionId: string },
): Promise<ProtocolGoalTarget | null> {
  if (!record.app.readTarget || !record.app.updateTargetStatus) {
    return null;
  }
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return null;
  }

  try {
    // Stop 只 abort controller 时，goal verifier 若没及时收到 abort，
    // 会在队列仍持有 stopRequested 的情况下保留 active goal，导致后续队列无法 drain。
    const pausedTarget = await record.app.updateTargetStatus("paused");
    if (pausedTarget) {
      context.logger?.info("ZCode Protocol session/stop paused active goal", {
        sessionId: params.sessionId,
        targetId: pausedTarget.targetID,
        workspacePath: record.workspace.workspacePath,
      });
    }
    return pausedTarget;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/stop failed to pause active goal", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: params.sessionId,
      targetId: target.targetID,
      workspacePath: record.workspace.workspacePath,
    });
    return null;
  }
}

export async function cancelBackgroundTask(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionCancelBackgroundTaskParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  context.logger?.info("ZCode Protocol session/cancelBackgroundTask received", {
    sessionId: params.sessionId,
    taskId: params.taskId,
    workspacePath: record.workspace.workspacePath,
  });

  if (!record.app.cancelBackgroundTask) {
    throw new ProtocolRequestError(
      -32031,
      "Background task cancellation is not supported by this session runtime",
      {
        sessionId: params.sessionId,
        taskId: params.taskId,
      },
    );
  }

  const result = await record.app.cancelBackgroundTask(params.taskId);
  // 后台 bash 取消是运行态变更，不会经过普通 prompt 终态。
  // 取消后立即发 state.updated，让桌面 continuous 和手机 replayable 都通过各自 snapshot 边界刷新投影。
  await afterStateMutation(context, record, "background_task_cancelled");
  return result;
}
