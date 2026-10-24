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
  ConversationSnapshot,
  ConversationTopicFrame,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";

import {
  type ConversationRowTargetResolution,
  type StableForkCandidateResolution,
} from "./product-projection.js";

import type { TopicFrameReservation } from "./topic-frame-reservation.js";

import * as implementation2 from "./topic-publisher-events.js";
import * as implementation4 from "./topic-publisher-flush.js";
import * as implementation5 from "./topic-publisher-resync.js";
import * as implementation1 from "./topic-publisher-row-queries.js";
import * as implementation0 from "./topic-publisher-snapshot.js";
import * as implementation3 from "./topic-publisher-subscribe.js";
import type { ConversationSubscribeResult } from "./topic-publisher-support.js";
export interface ConversationTopicPublisherApi {
  appendDeltas(
    ...args: Parameters<typeof implementation2.appendDeltas>
  ): ReturnType<typeof implementation2.appendDeltas>;
  getSnapshot(...args: Parameters<typeof implementation0.getSnapshot>): ConversationSnapshot;
  getWireSnapshotLogicalBytes(
    ...args: Parameters<typeof implementation0.getWireSnapshotLogicalBytes>
  ): number;
  resolveStableForkCandidate(
    ...args: Parameters<typeof implementation0.resolveStableForkCandidate>
  ): StableForkCandidateResolution;
  seedConfig(...args: Parameters<typeof implementation0.seedConfig>): void;
  seedSharedContextImport(
    ...args: Parameters<typeof implementation0.seedSharedContextImport>
  ): void;
  seedUsage(...args: Parameters<typeof implementation0.seedUsage>): void;
  seedSubagents(...args: Parameters<typeof implementation0.seedSubagents>): void;
  measureInputAdmissionProjectionBytes(
    ...args: Parameters<typeof implementation0.measureInputAdmissionProjectionBytes>
  ): number | null;
  getRowsRange(
    ...args: Parameters<typeof implementation1.getRowsRange>
  ): V4ConversationRowsRangeResult;
  getPlans(...args: Parameters<typeof implementation1.getPlans>): V4ConversationPlansResult;
  getMessageIdForRow(...args: Parameters<typeof implementation1.getMessageIdForRow>): string | null;
  resolveRowActionTarget(
    ...args: Parameters<typeof implementation1.resolveRowActionTarget>
  ): ConversationRowTargetResolution;
  getMessageIdsForTurnRow(
    ...args: Parameters<typeof implementation1.getMessageIdsForTurnRow>
  ): string[];
  isLatestAssistantSegmentRow(
    ...args: Parameters<typeof implementation1.isLatestAssistantSegmentRow>
  ): boolean;
  isLatestRetryAssistantRow(
    ...args: Parameters<typeof implementation1.isLatestRetryAssistantRow>
  ): boolean;
  isLatestEditableUserRow(
    ...args: Parameters<typeof implementation1.isLatestEditableUserRow>
  ): boolean;
  getTurnIdForRow(...args: Parameters<typeof implementation1.getTurnIdForRow>): string | null;
  getDroppedContentStreamEventCount(
    ...args: Parameters<typeof implementation1.getDroppedContentStreamEventCount>
  ): number;
  getTurnRewindAnchor(
    ...args: Parameters<typeof implementation1.getTurnRewindAnchor>
  ): string | null;
  ingest(...args: Parameters<typeof implementation2.ingest>): void;
  subscribe(...args: Parameters<typeof implementation3.subscribe>): ConversationSubscribeResult;
  subscribeReserved(
    ...args: Parameters<typeof implementation3.subscribeReserved>
  ): ConversationSubscribeResult;
  unsubscribe(...args: Parameters<typeof implementation3.unsubscribe>): void;
  hasSubscription(...args: Parameters<typeof implementation3.hasSubscription>): boolean;
  hasSubscribers(...args: Parameters<typeof implementation3.hasSubscribers>): boolean;
  connectionIdForSubscription(
    ...args: Parameters<typeof implementation3.connectionIdForSubscription>
  ): string | null;
  reserveFlush(
    ...args: Parameters<typeof implementation4.reserveFlush>
  ): TopicFrameReservation<ConversationTopicFrame> | null;
  flush(...args: Parameters<typeof implementation4.flush>): ConversationTopicFrame | null;
  resyncReserved(
    ...args: Parameters<typeof implementation5.resyncReserved>
  ): ConversationSubscribeResult | null;
  resync(...args: Parameters<typeof implementation5.resync>): ConversationTopicFrame | null;
}
