// Conversation topic 发布器（传输外壳）。
// CLI 侧权威运行时：内存有界 delta 日志（logEpoch + 保留窗）+ subscribe(base)
// 裁决（resume/snapshot）+ 每订阅者 flush 管线（filter → coalesce → 打帧）。
//
// 职责边界：
// - 本类只做「事件 → 帧」的权威记账，不做网络 IO / 定时器——flush 时机由宿主驱动
//   （host 通道层按 profile.flushWindowMs 调度；测试里手动调用），保持可测的纯推进。
// - 恢复与续流共用一条管线：resume 的初始帧 = 保留窗内 (base.seq, current] 的 delta
//   过该订阅者 profile 过滤再 coalesce，
//   因此「snapshot(W)+续流 ≡ 全量重放」黄金测试可直接覆盖恢复路径。
// - 重订阅 = 替换：同 connectionId 重复 subscribe 即作废旧订阅并清其
//   flush buffer，旧 subscriptionId 不再产帧，客户端按 subId 丢弃旧代际帧。

import type {
  ConversationRowTarget,
  DeliveryProfileName,
  ToolCallRow,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";

import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  filterConversationRowsForProfile,
} from "@zcode/shared/zcode-protocol-v4";

import {
  type ConversationRowTargetAction,
  type ConversationRowTargetResolution,
} from "./product-projection.js";

import { TERMINAL_PLAN_STATUSES, hasPlanMarkdown } from "./topic-publisher-support.js";

import type { ConversationTopicPublisherMethodsContext } from "./topic-publisher-context.js";
/**
 * rows/range（游标制）：取 rowId < beforeRowId 的最后 limit 行
 * （rowId 升序返回）。数据源 = 投影全量行（事件重放/transcript hydration 已灌入），
 * 与订阅流出自同一归约，天然满足「与全量重放前缀逐字节一致」。
 * 只读、无状态、超时重发安全；atLogEpoch 供客户端陈旧读整体丢弃。
 */

export function getRowsRange(
  this: ConversationTopicPublisherMethodsContext,
  params: { beforeRowId?: number; limit: number },
  deliveryProfile: DeliveryProfileName = "replayable",
): V4ConversationRowsRangeResult {
  const snapshot = this.projection.getSnapshot();
  const limit = Math.max(1, Math.min(params.limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
  const visibleRows = filterConversationRowsForProfile(
    snapshot.rows.window,
    DELIVERY_PROFILES[deliveryProfile],
  );
  const eligible =
    params.beforeRowId === undefined
      ? visibleRows
      : visibleRows.filter((row) => row.rowId < (params.beforeRowId as number));
  const rows = eligible.slice(-limit);
  return {
    rows,
    atSeq: snapshot.seq,
    atRevision: snapshot.revision,
    atLogEpoch: this.logEpoch,
    hasMore: eligible.length > rows.length,
  };
}

/**
 * 返回当前有效分支里的完整终态计划目录。
 * wire snapshot 只保留 tail window；renderer 扫描可见 rows 会漏掉早期计划，
 * edit/retry 后还可能保留已经被权威 projection 裁掉的旧目录项。
 */

export function getPlans(
  this: ConversationTopicPublisherMethodsContext,
): V4ConversationPlansResult {
  const snapshot = this.projection.getSnapshot();
  const plans = snapshot.rows.window
    .filter(
      (row): row is ToolCallRow =>
        row.kind === "toolCall" &&
        row.toolName === "ExitPlanMode" &&
        TERMINAL_PLAN_STATUSES.has(row.status) &&
        hasPlanMarkdown(row),
    )
    .toSorted((left, right) => right.rowId - left.rowId);
  return {
    plans,
    atSeq: snapshot.seq,
    atLogEpoch: this.logEpoch,
  };
}

/** rowId → 权威 messageId（forkAssistant/editUserQuery 桥接翻译）。 */

export function getMessageIdForRow(
  this: ConversationTopicPublisherMethodsContext,
  rowId: number,
): string | null {
  return this.projection.getMessageIdForRow(rowId);
}

export function resolveRowActionTarget(
  this: ConversationTopicPublisherMethodsContext,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
): ConversationRowTargetResolution {
  return this.projection.resolveRowActionTarget(target, action);
}

/** rowId → 同一 product turn 内所有 transcript messageId。 */

export function getMessageIdsForTurnRow(
  this: ConversationTopicPublisherMethodsContext,
  rowId: number,
): string[] {
  return this.projection.getMessageIdsForTurnRow(rowId);
}

/** fork 目标必须是所属轮最后一段 assistantText。 */

export function isLatestAssistantSegmentRow(
  this: ConversationTopicPublisherMethodsContext,
  rowId: number,
): boolean {
  return this.projection.isLatestAssistantSegmentRow(rowId);
}

/** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */

export function isLatestRetryAssistantRow(
  this: ConversationTopicPublisherMethodsContext,
  rowId: number,
): boolean {
  return this.projection.isLatestRetryAssistantRow(rowId);
}

/** latestQueryEditOnly：只有最后一轮 realUser userInput row 可 edit。 */

export function isLatestEditableUserRow(
  this: ConversationTopicPublisherMethodsContext,
  rowId: number,
): boolean {
  return this.projection.isLatestEditableUserRow(rowId);
}

/** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */

export function getTurnIdForRow(
  this: ConversationTopicPublisherMethodsContext,
  rowId: number,
): string | null {
  return this.projection.getTurnIdForRow(rowId);
}

/** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段）。 */

export function getDroppedContentStreamEventCount(
  this: ConversationTopicPublisherMethodsContext,
): number {
  return this.projection.getDroppedContentStreamEventCount();
}

/** rowId → 其 turn 的 rewind 锚点 messageId（editUserQuery user 行定位）。 */

export function getTurnRewindAnchor(
  this: ConversationTopicPublisherMethodsContext,
  rowId: number,
): string | null {
  return this.projection.getTurnRewindAnchor(rowId);
}
