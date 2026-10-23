// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type {
  SessionEvent,
  ToolCallProgressPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
} from "@zcode/contracts";

import { projectToolActivity } from "./product-projection-bash-progress.js";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）
import {
  ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS,
  extractPlanStepsFromToolInput,
  isZCodeFileStreamingToolInputPreviewTool,
} from "@zcode/shared";

import type { ConversationDelta, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";

import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";

import { readOfficialCuaAction, resolveCuaAppIdentity } from "./cua-app-snapshot.js";

import { type CanonicalModelStream } from "./event-normalizer.js";

import { stringifyToolInput } from "./product-projection-tool-display.js";
import type { ProductProjectionContext } from "./projection-context.js";
export function updateToolIndexesAfterDeltas(
  this: ProductProjectionContext,
  deltas: readonly ConversationDelta[],
): void {
  for (const delta of deltas) {
    if (delta.op === "row.appended" || delta.op === "row.upserted") {
      if (delta.row.kind !== "toolCall") continue;
      if (this.isOpenForegroundToolRow(delta.row)) {
        this.openForegroundToolCallIds.add(delta.row.toolCallId);
      } else {
        this.openForegroundToolCallIds.delete(delta.row.toolCallId);
      }
      continue;
    }
    if (delta.op !== "row.removed") continue;
    for (const [toolCallId, rowId] of this.toolRowIdByCallId) {
      if (rowId < delta.fromRowId) continue;
      // Bug 原因：rewind 过去只删 rows/message 索引，旧 toolCallId 仍会阻止新分支
      // 重新打开同 id 的流式工具；open tracker 也会留下已经不存在的 row。
      this.toolRowIdByCallId.delete(toolCallId);
      this.openForegroundToolCallIds.delete(toolCallId);
      this.fileToolInputPreviewByCallId.delete(toolCallId);
    }
    this.pruneRemovedSubagentIndexes();
  }
}

export function pruneRemovedSubagentIndexes(this: ProductProjectionContext): void {
  for (const [agentId, rowId] of this.subagentRowIdByAgentId) {
    if (this.findRow(rowId)?.kind === "subagent") continue;
    // Bug 原因：rewind 只重建 rowIndex，旧 agent alias 仍会被后续每次 subagent
    // materialization 枚举。仅在 row.removed 已应用后按权威 snapshot 清理一次，
    // 避免长会话随已删除历史持续增长；普通事件不会扫描该索引。
    this.subagentRowIdByAgentId.delete(agentId);
  }
}

// ── tool call 状态机 ──

export function openToolRow(
  this: ProductProjectionContext,
  event: SessionEvent,
  payload: CanonicalModelStream,
  entityId?: string,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  if (
    toolCallId === "" ||
    shouldHideInvalidToolCallFromProduct(payload.toolName) ||
    this.toolRowIdByCallId.has(toolCallId)
  ) {
    return [];
  }
  const row: ToolCallRow = {
    ...this.rowBase(event, this.turnIdOf(event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
    toolCallId,
    toolName: payload.toolName ?? "",
    status: "inputStreaming",
    inputText: "",
  };
  this.toolRowIdByCallId.set(toolCallId, row.rowId);
  if (isZCodeFileStreamingToolInputPreviewTool(row.toolName)) {
    this.fileToolInputPreviewByCallId.set(toolCallId, {
      lastPublishedAt: null,
      pendingAppend: "",
    });
  }
  if (entityId) this.entityIdByRowId.set(row.rowId, entityId);
  return [{ op: "row.appended", row }];
}

export function appendStreamingToolInput(
  this: ProductProjectionContext,
  event: SessionEvent,
  payload: CanonicalModelStream,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  const rowId = this.toolRowIdByCallId.get(toolCallId);
  if (rowId === undefined) return [];
  const state = this.fileToolInputPreviewByCallId.get(toolCallId);
  if (!state) {
    return [{ op: "row.delta", rowId, path: "inputText", append: payload.delta }];
  }

  state.pendingAppend += payload.delta;
  const now = this.ms(event);
  if (
    state.lastPublishedAt !== null &&
    now - state.lastPublishedAt < ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
  ) {
    return [];
  }

  const append = state.pendingAppend;
  state.pendingAppend = "";
  state.lastPublishedAt = now;
  return append === "" ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
}

export function flushStreamingToolInput(
  this: ProductProjectionContext,
  toolCallId: string,
): ConversationDelta[] {
  const append = this.takePendingStreamingToolInput(toolCallId);
  if (append === "") return [];
  const rowId = this.toolRowIdByCallId.get(toolCallId);
  return rowId === undefined ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
}

export function takePendingStreamingToolInput(
  this: ProductProjectionContext,
  toolCallId: string,
): string {
  const state = this.fileToolInputPreviewByCallId.get(toolCallId);
  this.fileToolInputPreviewByCallId.delete(toolCallId);
  return state?.pendingAppend ?? "";
}

export function finalizeStreamingToolInput(
  this: ProductProjectionContext,
  event: SessionEvent,
  payload: CanonicalModelStream,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  if (toolCallId === "") return [];
  this.fileToolInputPreviewByCallId.delete(toolCallId);
  if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
  const inputText = stringifyToolInput(payload.input);
  const existing = this.findToolRow(toolCallId);
  if (existing) {
    return [
      {
        op: "row.upserted",
        row: {
          ...existing,
          ...(payload.assistantResponseId
            ? { assistantResponseId: payload.assistantResponseId }
            : {}),
          toolName: existing.toolName || payload.toolName || "",
          inputText,
          input: payload.input,
        },
      },
    ];
  }

  const row: ToolCallRow = {
    ...this.rowBase(event, this.turnIdOf(event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
    toolCallId,
    toolName: payload.toolName ?? "",
    status: "inputStreaming",
    inputText,
    input: payload.input,
  };
  this.toolRowIdByCallId.set(toolCallId, row.rowId);
  return [{ op: "row.appended", row }];
}

export function onToolCallScheduled(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
  const payload = event.payload as ToolCallScheduledPayload;
  const toolCallId = String(payload.toolCallId);
  this.fileToolInputPreviewByCallId.delete(toolCallId);
  if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
  const inputText = stringifyToolInput(payload.input);
  const cuaAction = readOfficialCuaAction(payload.toolName);
  const cuaApp =
    cuaAction && cuaAction !== "list_apps"
      ? resolveCuaAppIdentity(payload.input, this.latestListAppsSnapshot)
      : undefined;
  const existing = this.findToolRow(toolCallId);
  const planDeltas = this.todoPlanDeltas(
    event,
    extractPlanStepsFromToolInput({
      title: payload.toolName,
      kind: payload.toolName,
      input: payload.input,
    }),
  );
  if (existing) {
    // replayable 会过滤 row.delta(inputText)，定稿 upsert 必须携带完整 inputText。
    // 否则断线恢复只能看到结构化 input，丢失 v4 row 的输入文本终态。
    return [
      {
        op: "row.upserted",
        row: {
          ...existing,
          ...(payload.assistantMessageId
            ? { assistantResponseId: String(payload.assistantMessageId) }
            : {}),
          inputText,
          input: payload.input,
          ...(cuaApp ? { cuaApp } : {}),
          ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
        },
      },
      ...planDeltas,
    ];
  }
  const row: ToolCallRow = {
    ...this.rowBase(event, this.turnIdOf(event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantMessageId
      ? { assistantResponseId: String(payload.assistantMessageId) }
      : {}),
    toolCallId,
    toolName: payload.toolName,
    status: "inputStreaming",
    inputText,
    input: payload.input,
    ...(cuaApp ? { cuaApp } : {}),
    ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
  };
  this.toolRowIdByCallId.set(toolCallId, row.rowId);
  return [{ op: "row.appended", row }, ...planDeltas];
}

export function onToolCallActivity(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
  const payload = event.payload as ToolCallStartedPayload;
  this.recordHighspeedToolStarted(this.turnIdOf(event), String(payload.toolCallId), this.ms(event));
  const row = this.findToolRow(String(payload.toolCallId));
  if (!row) return [];
  return projectToolActivity(event, row);
}

/**
 * MCP `notifications/progress`（A8）→ 行上的 progress。只在 running 时写：
 * 终态之后迟到的进度通知不能把 success/error 行重新点亮；bash 的 stdout 字节进度不在这里消费。
 */

export function onToolCallProgress(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
  const payload = event.payload as ToolCallProgressPayload;
  const row = this.findToolRow(String(payload.toolCallId));
  if (!row || row.status !== "running") return [];
  // 两个分支共用 ToolCallProgress：Bash 尾窗与 MCP 百分比必须分别投影，避免合并后互相覆盖。
  if (row.toolName === "Bash") return projectToolActivity(event, row);
  const total =
    typeof payload.total === "number" && Number.isFinite(payload.total) && payload.total > 0
      ? payload.total
      : undefined;
  const fraction =
    total !== undefined && typeof payload.progress === "number" && Number.isFinite(payload.progress)
      ? Math.min(1, Math.max(0, payload.progress / total))
      : undefined;
  const message =
    typeof payload.message === "string" && payload.message.trim().length > 0
      ? payload.message.trim().slice(0, 200)
      : undefined;
  if (fraction === undefined && message === undefined && total === undefined) return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        progress: {
          ...(fraction !== undefined ? { fraction } : {}),
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
          updatedAt: this.ms(event),
        },
      },
    },
  ];
}
