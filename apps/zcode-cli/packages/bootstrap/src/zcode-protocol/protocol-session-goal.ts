import { zcodeSessionGoalParamsSchema } from "@zcode/shared";
import {
  ProtocolRequestError,
  assertExpectedRevision,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { runWithSessionResidencyFinalization } from "./session-residency.js";
import { snapshot } from "./protocol-session-snapshot.js";
import { afterStateMutation } from "./protocol-state-notifications.js";
import { ensureSessionModelAvailableForNextTurn } from "./protocol-session-model.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
const PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE = "Plan mode 下已记录 goal，但不会自动继续。";

export type ProtocolGoalTarget = NonNullable<
  Awaited<ReturnType<NonNullable<ZCodeProtocolSessionRecord["app"]["readTarget"]>>>
>;

export async function goalSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionGoalParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  // /goal 是目标状态写入，不是普通 prompt；除 pause 外运行中允许执行会绕过前端队列并污染当前 turn。
  // pause 是用户显式停止 active goal 的控制面命令，必须能打断当前 assistant turn 或 verifier。
  const goalPauseMayInterruptActiveTurn = params.action === "pause";
  if (!goalPauseMayInterruptActiveTurn) {
    ensureNoActiveTurn(record, "Cannot manage goals while a prompt is running");
  }

  if (
    !record.app.readTarget ||
    !record.app.setTarget ||
    !record.app.updateTargetStatus ||
    !record.app.clearTarget
  ) {
    return {
      response: "Goal management is not available in this client.",
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  if (params.action === "show") {
    return {
      response: formatGoalSummary(await record.app.readTarget()),
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  if (params.action === "pause") {
    const activeAbortController = record.activeAbortController;
    const target = await record.app.updateTargetStatus("paused");
    if (target && activeAbortController) {
      context.logger?.info("ZCode Protocol goal pause aborting active turn", {
        inputId: params.inputId,
        sessionId: params.sessionId,
        targetId: target.targetID,
        workspacePath: record.workspace.workspacePath,
      });
      activeAbortController.abort(new Error("ZCode Protocol goal paused"));
    }
    const snapshotAfterGoal = await afterStateMutation(context, record, "goal_paused");
    return {
      // pause 是状态控制动作，UI 已通过目标面板和 runtime 收口体现结果；
      // 返回 "Goal paused Objective..." 会被渲染成一条无意义 assistant 气泡并重复暴露目标正文。
      response: target ? "" : "No goal to pause.",
      snapshot: snapshotAfterGoal,
      startedTurn: false,
    };
  }

  if (params.action === "resume") {
    const target = await record.app.updateTargetStatus("active");
    if (!target) {
      return {
        response: "No goal to resume.",
        snapshot: await snapshot(context, record),
        startedTurn: false,
      };
    }
    return await continueGoalAfterChange(context, record, {
      inputId: params.inputId,
      reason: "goal_resumed",
      target,
      title: "Goal resumed",
    });
  }

  if (params.action === "clear") {
    const cleared = await record.app.clearTarget();
    const snapshotAfterGoal = await afterStateMutation(context, record, "goal_cleared");
    return {
      response: cleared ? "Goal cleared." : "No goal to clear.",
      snapshot: snapshotAfterGoal,
      startedTurn: false,
    };
  }

  const objective = params.objective?.trim() ?? "";
  if (objective.length === 0) {
    return {
      response:
        params.action === "replace"
          ? "Usage: /goal replace <objective>"
          : "Usage: /goal <objective>",
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  // App 输入框里的 `/goal 新目标` 是用户显式提交的新目标；已有目标时继续要求
  // replace 会让用户以为目标已变更但数据库仍保留旧目标。这里把重复 set 收敛成 replace 语义。
  const replacesExistingGoal =
    params.action === "replace" || Boolean(await record.app.readTarget());

  const target = await record.app.setTarget({ objective, status: "active" });
  return await continueGoalAfterChange(context, record, {
    inputId: params.inputId,
    reason: replacesExistingGoal ? "goal_replaced" : "goal_set",
    target,
    title: "Goal active",
  });
}

async function continueGoalAfterChange(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    inputId?: string;
    reason: string;
    target: ProtocolGoalTarget;
    title: string;
  },
) {
  const response = formatGoalChanged(params.title, params.target);
  const isPlanMode = record.app.runtime.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  // continueActiveTarget 是 App 的必选能力；能否继续只取决于当前模式和是否已有活跃 turn。
  const canContinue = !isPlanMode && !record.activeAbortController;

  if (canContinue) {
    await ensureSessionModelAvailableForNextTurn(context, record);
    const abortController = new AbortController();
    record.activeAbortController = abortController;
    void runWithSessionResidencyFinalization(record, () =>
      runGoalContinuationInBackground(context, record, {
        abortController,
        inputId: params.inputId,
      }),
    ).catch(() => {
      // 后台 goal continuation 的失败会通过状态/事件流降级上报；这里兜底防 unhandled rejection。
    });
  }

  const snapshotAfterGoal = await afterStateMutation(context, record, params.reason);
  return {
    response: isPlanMode ? appendPlanModeGoalContinuationNote(response) : response,
    snapshot: snapshotAfterGoal,
    startedTurn: canContinue,
  };
}

async function runGoalContinuationInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    inputId?: string;
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  } finally {
    if (record.activeAbortController === params.abortController) {
      // 续跑本身结束后应立刻释放活跃锁；snapshot/command discovery 只是后续广播，
      // 如果继续占锁，连续 `/goal` 会被误判为已有活跃 turn。
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

export function ensureNoActiveTurn(record: ZCodeProtocolSessionRecord, message: string): void {
  if (!record.activeAbortController) {
    return;
  }
  throw new ProtocolRequestError(-32010, message);
}

function appendPlanModeGoalContinuationNote(response: string): string {
  return `${response}\n\n${PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE}`;
}

function formatGoalSummary(target: ProtocolGoalTarget | null): string {
  if (!target) {
    return "No goal is set. Use /goal <objective> to set one.";
  }

  return formatGoalChanged(`Goal ${target.status}`, target);
}

function formatGoalChanged(title: string, target: ProtocolGoalTarget): string {
  const lines = [title, `Objective: ${target.objective}`];
  if (target.tokensUsed !== undefined || target.tokenBudget !== undefined) {
    const budget =
      target.tokenBudget === null || target.tokenBudget === undefined
        ? "none"
        : target.tokenBudget.toString();
    lines.push(`Usage: ${target.tokensUsed ?? 0} tokens / ${budget}`);
  }
  if (target.timeUsedSeconds !== undefined) {
    lines.push(`Time: ${target.timeUsedSeconds} seconds`);
  }
  return lines.join("\n");
}
