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
import { SessionEventType, type SessionEvent } from "@zcode/contracts";

import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";

import { PROTOCOL_V4_LIMITS, utf8JsonByteLength } from "@zcode/shared/zcode-protocol-v4";

import { workflowRunDeltaGrowthUpperBound } from "./conversation-workflow-run-deltas.js";

import {
  HYDRATION_ACTION_BYTES_PER_WIRE_ROW,
  HYDRATION_EVENT_WIRE_OVERHEAD_BYTES,
  PROJECTION_TERMINAL_RESERVE_BYTES,
  ProjectionPayloadTooLargeError,
  appendConversationSubscriberBuffer,
  coldHydrationJsonByteLength,
  hydrationSequenceNumberBytes,
} from "./topic-publisher-support.js";

import type { ConversationTopicPublisherMethodsContext } from "./topic-publisher-context.js";
/** 应用权威事件：投影推进 + 日志记账 + 扇出到各订阅者 flush buffer。 */

export function ingest(this: ConversationTopicPublisherMethodsContext, event: SessionEvent): void {
  const projectionLimit =
    event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
      ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
      : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
  const streamingAppend = this.projection.establishedStreamingAppend(event);
  const streamingUpperBound =
    streamingAppend === null ? null : utf8JsonByteLength(streamingAppend) + 64;
  let deltas: ConversationDelta[] | null;
  if (
    streamingUpperBound !== null &&
    this.wireSnapshotBytesUpperBound + streamingUpperBound <= projectionLimit
  ) {
    deltas = this.projection.applyEvent(event);
    this.wireSnapshotBytesUpperBound += streamingUpperBound;
  } else {
    let candidateBytes = 0;
    let nextUpperBound = 0;
    deltas = this.projection.applyEventAtomically(event, (snapshot, produced) => {
      // dwf 快路径：这条事件只产键级增量时，它们的字节数就是快照增长的上界（一条 upsert
      // 最多把自己那点内容加进去，removed 只会让快照变小），不必把整份快照再序列化一遍
      // ——那一次 JSON.stringify 是每条引擎事件都要付的 MB 级开销，也是这次改造的另一半。
      // 判据用的是**实际产出**而不是预演，所以 diff 退化出的整键 patch 自然落回精确路径。
      const growth = workflowRunDeltaGrowthUpperBound(produced);
      if (growth !== null && this.wireSnapshotBytesUpperBound + growth <= projectionLimit) {
        nextUpperBound = this.wireSnapshotBytesUpperBound + growth;
        return true;
      }
      candidateBytes = this.measureWireSnapshotBytes(this.getWireSnapshot(snapshot));
      nextUpperBound = candidateBytes;
      return candidateBytes <= projectionLimit;
    });
    if (deltas === null) throw new ProjectionPayloadTooLargeError(candidateBytes);
    this.wireSnapshotBytesUpperBound = nextUpperBound;
  }
  this.appendDeltas(event.sequenceNumber, deltas);
}

export function appendDeltas(
  this: ConversationTopicPublisherMethodsContext,
  seq: number,
  deltas: ConversationDelta[],
): void {
  this.log.push({ seq, deltas });
  while (this.log.length > this.retention) {
    const evicted = this.log.shift();
    if (evicted) this.floorSeq = evicted.seq;
  }
  if (deltas.length === 0) return;
  for (const subscription of this.subscriptions.values()) {
    if (subscription.resyncRequired) continue;
    const filtered = this.encodeDeltasForSubscription(deltas, subscription);
    const next = appendConversationSubscriberBuffer(
      subscription.buffer,
      filtered,
      this.subscriberBufferLimits(),
    );
    if (next.kind === "overflow") {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
      continue;
    }
    subscription.buffer = next.deltas;
    subscription.bufferBytes = next.encodedBytes;
  }
}

/**
 * 冷恢复快路径：只修改尚未发布的 candidate。协议 wire snapshot 固定只含末尾 60 行，
 * 因此 row 更新只累计仍在 tail 的 delta，再给尚未 materialize 的 actions 按行预留
 * 完整 schema 上界；已滑出 tail 的保守增长在触及 payload limit 时通过精确测量消除。
 * 最终只做一次全行 actions 收敛，整体成本随事件/行数线性增长。
 */

export function tryBatchHydration(
  this: ConversationTopicPublisherMethodsContext,
  events: readonly SessionEvent[],
): boolean {
  this.projection.beginHydrationReplay();
  let measuredBytes = this.wireSnapshotBytesUpperBound;
  let measuredSequenceNumberBytes = hydrationSequenceNumberBytes(this.projection.getSnapshot().seq);
  let encodedGrowthSinceMeasurement = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const deltas = this.projection.applyHydrationEvent(event);
    const finalEvent = index === events.length - 1;
    const projectionLimit = this.projectionLimitForEvent(event);
    const mustMeasureSnapshot = finalEvent || deltas.some((delta) => delta.op === "row.removed");

    if (finalEvent) this.projection.completeHydrationReplay();
    const snapshot = this.projection.getSnapshot();
    if (!mustMeasureSnapshot && deltas.length > 0) {
      let wireRowIds: Set<number> | undefined;
      const wireDeltas = deltas.filter((delta) => {
        if (delta.op === "state.updated" || delta.op === "row.appended") return true;
        if (delta.op === "row.removed") return false;
        // 4b-2：插件资源通知只走实时增量，不进冷启动测量。
        if (
          delta.op === "pluginUi.resourceUpdated" ||
          delta.op === "pluginUi.resourceListChanged" ||
          delta.op === "pluginUi.appToolCall" ||
          delta.op === "pluginUi.instanceClosed"
        )
          return false;
        // 键级增量作用在状态键上，不在 60 行 wire tail 里——没有「已滑出窗口所以不计」这一说，
        // 与 state.updated 同规一律计入。
        if (delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed") return true;
        wireRowIds ??= new Set(
          snapshot.rows.window
            .slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows)
            .map((row) => row.rowId),
        );
        const rowId = delta.op === "row.upserted" ? delta.row.rowId : delta.rowId;
        return wireRowIds.has(rowId);
      });
      if (wireDeltas.length > 0) {
        encodedGrowthSinceMeasurement +=
          coldHydrationJsonByteLength({ kind: "deltas", deltas: wireDeltas }) +
          HYDRATION_EVENT_WIRE_OVERHEAD_BYTES;
      }
    }

    const actionBytesUpperBound = finalEvent
      ? 0
      : Math.min(snapshot.rows.window.length, PROTOCOL_V4_LIMITS.snapshotTailWindowRows) *
        HYDRATION_ACTION_BYTES_PER_WIRE_ROW;
    const currentSequenceNumberBytes = hydrationSequenceNumberBytes(snapshot.seq);
    const sequenceNumberGrowth = Math.max(
      0,
      currentSequenceNumberBytes - measuredSequenceNumberBytes,
    );
    let upperBound =
      measuredBytes + encodedGrowthSinceMeasurement + sequenceNumberGrowth + actionBytesUpperBound;
    if (mustMeasureSnapshot || upperBound > projectionLimit) {
      // 保守 delta 累计值一旦超限就直接回退 strict 的话，重复 upsert
      // 即使未增大 snapshot 也会误回退；固定 32-event 重测还会反复序列化 checkpoint。
      measuredBytes = this.measureWireSnapshotBytes(this.getWireSnapshot());
      measuredSequenceNumberBytes = currentSequenceNumberBytes;
      encodedGrowthSinceMeasurement = 0;
      upperBound = measuredBytes + actionBytesUpperBound;
    }
    if (upperBound > projectionLimit) return false;
  }

  if (events.length === 0) {
    this.projection.completeHydrationReplay();
    measuredBytes = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }
  this.wireSnapshotBytesUpperBound = measuredBytes;
  return true;
}

export function projectionLimitForEvent(
  this: ConversationTopicPublisherMethodsContext,
  event: SessionEvent,
): number {
  return event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
    ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
    : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
}
