// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type { SessionEvent } from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）

import type {
  ConversationDelta,
  ConversationRow,
  SubagentRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";

import { type CanonicalOpenSegmentIdentity } from "./event-normalizer.js";

import type { ProductProjectionContext } from "./projection-context.js";
export function isMirroredSubagentToolEvent(
  this: ProductProjectionContext,
  event: SessionEvent,
): boolean {
  const payload = event.payload as unknown as Record<string, unknown>;
  // Bug 原因：child tool lifecycle 会镜像到父 runtime，但它不是父 session 的工具事实。
  // V4 过去把 mirror 当普通 ToolCallRow，导致 main timeline 展示 child 的 Read/Bash，
  // 并让 replayable snapshot 同样带上脏 row。完整工具历史只应由 child topic 物化。
  return payload.source === "subagent";
}

export function openAssistantSegments(
  this: ProductProjectionContext,
): Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> {
  const segments: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> = {};
  const text = this.openSegmentIdentity(this.streamingTextRowId);
  const reasoning = this.openSegmentIdentity(this.streamingReasoningRowId);
  if (text) segments.text = text;
  if (reasoning) segments.reasoning = reasoning;
  return segments;
}

export function openSegmentIdentity(
  this: ProductProjectionContext,
  rowId: number | null,
): CanonicalOpenSegmentIdentity | null {
  if (rowId === null) return null;
  const entityId = this.entityIdByRowId.get(rowId);
  if (!entityId) return null;
  return {
    entityId,
    transcriptMessageId: this.messageIdByRowId.get(rowId) ?? null,
  };
}

export function rowBase(
  this: ProductProjectionContext,
  event: SessionEvent,
  turnId: string,
  entityId: string = String(event.id),
): Required<
  Pick<
    ConversationRow,
    "rowId" | "turnId" | "entityId" | "productTurnId" | "visibility" | "createdAt" | "createdAtSeq"
  >
> {
  const rowId = this.nextRowId++;
  this.entityIdByRowId.set(rowId, entityId);
  return {
    rowId,
    turnId,
    entityId,
    productTurnId: turnId,
    visibility: "visible" as const,
    createdAt: this.ms(event),
    createdAtSeq: event.sequenceNumber,
  };
}

export function turnIdOf(this: ProductProjectionContext, event: SessionEvent): string {
  const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
  // queue drain 切轮后，同一 runtimeTurn 的后续事件行归入最新 productTurn。
  return this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
}

export function ms(this: ProductProjectionContext, event: SessionEvent): number {
  return event.timestamp.getTime();
}

export function findRow(
  this: ProductProjectionContext,
  rowId: number,
): ConversationRow | undefined {
  const index = this.rowIndexById.get(rowId);
  return index === undefined ? undefined : this.snapshot.rows.window[index];
}

export function updateRowIndexAfterImmutableApply(
  this: ProductProjectionContext,
  previousRowsLength: number,
  deltas: readonly ConversationDelta[],
): void {
  if (deltas.some((delta) => delta.op === "row.removed")) {
    this.rowIndexById = new Map(this.snapshot.rows.window.map((row, index) => [row.rowId, index]));
    return;
  }
  let nextIndex = previousRowsLength;
  for (const delta of deltas) {
    if (delta.op !== "row.appended") continue;
    this.rowIndexById.set(delta.row.rowId, nextIndex);
    nextIndex += 1;
  }
}

export function findToolRow(
  this: ProductProjectionContext,
  toolCallId: string,
): ToolCallRow | undefined {
  const rowId = this.toolRowIdByCallId.get(toolCallId);
  if (rowId === undefined) return undefined;
  const row = this.findRow(rowId);
  return row?.kind === "toolCall" ? row : undefined;
}

export function findSubagentRow(
  this: ProductProjectionContext,
  agentId: string,
): SubagentRow | undefined {
  const rowId = this.subagentRowIdByAgentId.get(agentId);
  if (rowId === undefined) return undefined;
  const row = this.findRow(rowId);
  return row?.kind === "subagent" ? row : undefined;
}

export function findSubagentLifecycleRow(
  this: ProductProjectionContext,
  agentId: string,
  payload: Record<string, unknown>,
  event: SessionEvent,
): SubagentRow | undefined {
  const exact = this.findSubagentRow(agentId);
  if (exact) return exact;

  const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
  if (!parentToolCallId) return undefined;
  const turnId = this.turnIdOf(event);
  // 晚订阅 hydration 无法从后台 Agent 的文本 tool output 恢复真实 agentId，
  // 会先用 toolCallId 合成一条 SubagentRow。后到的 live lifecycle 携带真实 agentId，
  // 旧逻辑因此追加第二行，UI 又会让无 childSessionId 的合成行抢占配对。父 tool call
  // 在同一 turn 内是稳定唯一身份，这里将真实事件归并回合成行并补齐 childSessionId。
  return this.snapshot.rows.window.find(
    (row): row is SubagentRow =>
      row.kind === "subagent" && row.turnId === turnId && row.parentToolCallId === parentToolCallId,
  );
}

export function subagentAgentId(
  this: ProductProjectionContext,
  payload: Record<string, unknown>,
  event: SessionEvent,
): string {
  return (
    this.stringPayload(payload, "agentId") ??
    this.stringPayload(payload, "childSessionId") ??
    this.stringPayload(payload, "parentToolCallId") ??
    `subagent-${event.sequenceNumber}`
  );
}

export function stringPayload(
  this: ProductProjectionContext,
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function mapSubagentStatus(
  this: ProductProjectionContext,
  status: string | undefined,
): SubagentRow["status"] {
  switch (status) {
    case "completed":
    case "success":
      return "success";
    case "cancelled":
    case "stopped":
      return "cancelled";
    default:
      return "failed";
  }
}
