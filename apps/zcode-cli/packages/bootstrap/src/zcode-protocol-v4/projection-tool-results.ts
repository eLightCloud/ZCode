// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type {
  AssistantFeedbackUpdatedPayload,
  HighspeedMetricsUpdatedPayload,
  SessionEvent,
  ToolCallErrorPayload,
  ToolCallResultPayload,
} from "@zcode/contracts";

import { CoreErrorType } from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）
import { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } from "@zcode/shared";

import type {
  AssistantTextRow,
  ConversationDelta,
  ToolCallRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";

import { parseListAppsSnapshot, readOfficialCuaAction } from "./cua-app-snapshot.js";

import { buildToolOutput } from "./projection-rows.js";

import { toProtocolToolCallDisplay } from "./product-projection-tool-display.js";
import type { ProductProjectionContext } from "./projection-context.js";
export function onToolCallResult(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
  const payload = event.payload as ToolCallResultPayload;
  const toolCallId = String(payload.toolCallId);
  this.recordHighspeedToolEnded(this.turnIdOf(event), toolCallId, this.ms(event), payload.duration);
  const row = this.findToolRow(toolCallId);
  if (!row) return [];
  const success = payload.result.success;
  if (success && readOfficialCuaAction(row.toolName) === "list_apps") {
    // 摘要身份必须来自 Agent 已观察到的成功事实；失败结果不能清空旧快照。
    const snapshot = parseListAppsSnapshot(payload.result.content, payload.result.display);
    if (snapshot) this.latestListAppsSnapshot = snapshot;
  }
  const display = toProtocolToolCallDisplay(payload.result.display);
  const next: ToolCallRow = {
    ...row,
    status: success ? "success" : "error",
    // 终态清除运行中进度（R7）。
    progress: undefined,
    output: buildToolOutput(payload.result, toolCallId),
    ...(display ? { display } : {}),
    endedAt: this.ms(event),
  };
  if (!success) {
    next.error = {
      code: payload.result.error?.type ?? "fault.runtime.toolFailed",
      message: payload.result.error?.message ?? "Tool execution failed.",
    };
  }
  const planDeltas = success
    ? this.todoPlanDeltas(
        event,
        extractPlanStepsFromToolOutput({
          title: row.toolName,
          kind: row.toolName,
          output: payload.result.content,
        }),
      )
    : [];
  return [{ op: "row.upserted", row: next }, ...planDeltas];
}

/**
 * TodoWrite 同时投影 live plan 与当前 goal iteration。
 * V4 之前只保留 tool row，右上角摘要无法在 live/cold 恢复后重建每轮 action/status。
 * 轮次只由 verifier boundary 推进；TodoWrite 只更新当前打开轮次，不能自行加一轮。
 */

export function todoPlanDeltas(
  this: ProductProjectionContext,
  event: SessionEvent,
  steps: ReturnType<typeof extractPlanStepsFromToolInput>,
): ConversationDelta[] {
  if (!steps) return [];
  const items = steps.map((step, index) => ({
    id: step.id || `todo-${index + 1}`,
    content: step.title,
    status:
      step.status === "in_progress"
        ? ("inProgress" as const)
        : step.status === "completed"
          ? ("completed" as const)
          : ("pending" as const),
  }));
  const updatedAt = this.ms(event);
  const goal = this.snapshot.goal;
  if (!goal) {
    return [{ op: "state.updated", patch: { plan: { items, updatedAt } } }];
  }

  const iteration =
    goal.status === "verifying" || goal.status === "verified" || goal.status === "failed"
      ? Math.max(1, goal.iteration)
      : Math.max(1, goal.iteration + 1);
  const iterations = [
    ...goal.iterations.filter((entry) => entry.iteration !== iteration),
    { iteration, items, updatedAt },
  ].sort((left, right) => left.iteration - right.iteration);
  return [
    {
      op: "state.updated",
      patch: {
        goal: { ...goal, iterations },
        plan: { items, updatedAt },
      },
    },
  ];
}

export function onToolCallError(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
  const payload = event.payload as ToolCallErrorPayload;
  this.recordHighspeedToolEnded(this.turnIdOf(event), String(payload.toolCallId), this.ms(event));
  const row = this.findToolRow(String(payload.toolCallId));
  if (!row) return [];
  const cancelled =
    payload.error.type === CoreErrorType.ToolCancelled || payload.error.code === "TOOL_CANCELLED";
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        // Stop 会先产生 tool_cancelled，再产生 cancelled turn；若先把工具
        // 终态写成 error，后续只收口 running row 的 turn reducer 无法纠正为 stopped。
        status: cancelled ? "cancelled" : "error",
        progress: undefined,
        ...(cancelled
          ? { error: undefined }
          : { error: { code: payload.error.type, message: payload.error.message } }),
        endedAt: this.ms(event),
      },
    },
  ];
}

export function onAssistantFeedbackUpdated(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as AssistantFeedbackUpdatedPayload;
  const row = this.snapshot.rows.window.find(
    (candidate): candidate is AssistantTextRow =>
      candidate.kind === "assistantText" && candidate.entityId === payload.entityId,
  );
  if (!row) return [];
  if (payload.feedback === null) {
    if (row.feedback === undefined) return [];
    const { feedback: _removedFeedback, ...withoutFeedback } = row;
    return [{ op: "row.upserted", row: withoutFeedback }];
  }
  if (row.feedback === payload.feedback) return [];
  return [{ op: "row.upserted", row: { ...row, feedback: payload.feedback } }];
}

export function onHighspeedMetricsUpdated(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as HighspeedMetricsUpdatedPayload;
  const row = this.snapshot.rows.window.find(
    (candidate): candidate is UserInputRow =>
      candidate.kind === "userInput" && candidate.entityId === payload.entityId,
  );
  if (!row) return [];
  // Bug 根因：终态指标更新曾整体替换 row.highspeed。payload 来自 transcript 原始 metadata + 耗时字段，
  // 不含 live 投影刚由 TurnExecutionModelFallback 写入的 fallbackAt；降级 Toast 依赖的字段被清空，
  // live 与 cold/replay 的结果也不一致。指标更新是增量补充：字段级合并、只增不删（spec §5）。
  return [
    {
      op: "row.upserted",
      row: { ...row, highspeed: { ...row.highspeed, ...payload.highspeed } },
    },
  ];
}
