// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import type { ConversationRowTarget, QueueItem } from "@zcode/shared/zcode-protocol-v4";

import type { ConversationRowTargetAction } from "./product-projection.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
export function getQueueItem(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  queueItemId: string,
): QueueItem | null {
  const snapshot = this.publishers.get(sessionId)?.getSnapshot();
  const item = snapshot?.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  return item ?? null;
}

export function hasQueueItemKind(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  kind: QueueItem["kind"],
): boolean {
  return Boolean(
    this.publishers
      .get(sessionId)
      ?.getSnapshot()
      .queue.items.some((candidate) => candidate.kind === kind),
  );
}

export function hasQueuedDelivery(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  delivery: "guide" | "queue",
): boolean {
  return Boolean(
    this.publishers
      .get(sessionId)
      ?.getSnapshot()
      .queue.items.some((candidate) => candidate.delivery.admitted === delivery),
  );
}

export function getQueueLength(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): number {
  return this.publishers.get(sessionId)?.getSnapshot().queue.items.length ?? 0;
}

/** Resident 回收保护：publisher queue 与 CommandInbox pinned facts 任一存在都不可关闭。 */

export function hasResidencyBlockingCommands(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): boolean {
  return this.getQueueLength(sessionId) > 0 || this.inbox.hasPinnedSessionState(sessionId);
}

export function getQueueHead(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): {
  autoDrain: boolean;
  dispatchState: QueueItem["dispatch"]["state"];
  kind: QueueItem["kind"];
  queueItemId: string;
  text: string;
} | null {
  const snapshot = this.publishers.get(sessionId)?.getSnapshot();
  const item = snapshot?.queue.items[0];
  if (!snapshot || !item) return null;
  return {
    autoDrain: snapshot.queue.autoDrain,
    dispatchState: item.dispatch.state,
    kind: item.kind,
    queueItemId: item.queueItemId,
    text: item.text,
  };
}

/**
 * 当前输入路由模式（v4 原生能力，供命令层 host.getInputRoutingMode 使用）：
 * held choice 裁决（heldQueueInputRequiresChoice）读投影 inputRouting.mode。
 */

export function getInputRoutingMode(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null {
  return this.publishers.get(sessionId)?.getSnapshot().inputRouting.mode ?? null;
}

export function getSessionFollowupMode(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): "queue" | "guide" | null {
  return this.publishers.get(sessionId)?.getSnapshot().config.followupMode ?? null;
}

/**
 * rowId → 权威 messageId（v4 原生能力，供 forkAssistant/retryTurn 定位 assistant 行）。
 * 会话无 publisher / 行不存在 / 非 assistant 行 → null（命令层据此 reject，不静默兜底）。
 */

export function getMessageIdForRow(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  rowId: number,
): string | null {
  return this.publishers.get(sessionId)?.getMessageIdForRow(rowId) ?? null;
}

export function resolveRowActionTarget(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
) {
  return this.publishers.get(sessionId)?.resolveRowActionTarget(target, action) ?? null;
}

/** rowId → 所属 product turn 内所有 transcript messageId（文件摘要撤销 / diff 查询）。 */

export function getMessageIdsForTurnRow(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  rowId: number,
): string[] {
  return this.publishers.get(sessionId)?.getMessageIdsForTurnRow(rowId) ?? [];
}

/** fork 目标必须是所属轮最后一段 assistantText（无投影 → null，按未知处理）。 */

export function isLatestAssistantSegmentRow(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  rowId: number,
): boolean | null {
  return this.publishers.get(sessionId)?.isLatestAssistantSegmentRow(rowId) ?? null;
}

export function resolveStableForkCandidate(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  rowId: number,
) {
  return this.publishers.get(sessionId)?.resolveStableForkCandidate(rowId) ?? null;
}

/** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */

export function isLatestRetryAssistantRow(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  rowId: number,
): boolean | null {
  return this.publishers.get(sessionId)?.isLatestRetryAssistantRow(rowId) ?? null;
}

/** latestQueryEditOnly：edit 目标必须是当前投影里的最后一条 realUser userInput row。 */

export function isLatestEditableUserRow(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  rowId: number,
): boolean | null {
  return this.publishers.get(sessionId)?.isLatestEditableUserRow(rowId) ?? null;
}

/** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */

export function getTurnIdForRow(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  rowId: number,
): string | null {
  return this.publishers.get(sessionId)?.getTurnIdForRow(rowId) ?? null;
}

/**
 * rowId → 所属 turn 的 rewind 锚点 messageId（供 editUserQuery：user 行无 messageId，
 * 用同 turn 内 assistant 行的 messageId 作 `/rewind` 目标）。
 */

export function getTurnRewindAnchor(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  rowId: number,
): string | null {
  return this.publishers.get(sessionId)?.getTurnRewindAnchor(rowId) ?? null;
}
