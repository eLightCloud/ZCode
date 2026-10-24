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
  CommandEnvelope,
  ConversationDelta,
  ConversationSnapshot,
  ConversationTopicFrame,
  DeliveryProfile,
  QueueItem,
} from "@zcode/shared/zcode-protocol-v4";

import {
  DELIVERY_PROFILES,
  statePatchSchema,
  PROTOCOL_V4_LIMITS,
  clampWorkflowRunsForLegacy,
  filterConversationDeltasForProfile,
  filterConversationRowsForProfile,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";

import { encodeConversationDeltasForLegacy } from "./conversation-workflow-run-deltas.js";

import {
  type SessionConfigSeed,
  type SessionSubagentsSeed,
  type SessionUsageSeed,
  type StableForkCandidateResolution,
} from "./product-projection.js";

import type { ConversationTopicPublisherMethodsContext } from "./topic-publisher-context.js";
import type { Subscription } from "./topic-publisher-support.js";
export function getSnapshot(this: ConversationTopicPublisherMethodsContext): ConversationSnapshot {
  return this.projection.getSnapshot();
}

/** 测试/闸门共用的 logical TopicFrame 字节口径（不是裸 snapshot 大小）。 */

export function getWireSnapshotLogicalBytes(
  this: ConversationTopicPublisherMethodsContext,
): number {
  return this.measureWireSnapshotBytes(this.getWireSnapshot());
}

export function resolveStableForkCandidate(
  this: ConversationTopicPublisherMethodsContext,
  rowId: number,
): StableForkCandidateResolution {
  return this.projection.resolveStableForkCandidate(rowId);
}

/** config 种子注入：直改投影初值，不产 delta / 不进事件日志。语义见 ProductProjection.seedConfig。 */

export function seedConfig(
  this: ConversationTopicPublisherMethodsContext,
  seed: SessionConfigSeed,
): void {
  this.projection.seedConfig(seed);
  this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
}

/** 分享导入提示是静态只读元数据，不进入 delta/revision；可在 hydration 后幂等补种。 */

export function seedSharedContextImport(
  this: ConversationTopicPublisherMethodsContext,
  source: ConversationSnapshot["sharedContextImport"] | null | undefined,
): void {
  this.projection.seedSharedContextImport(source);
  this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
}

/** usage 种子注入：冷恢复用持久化 token 水位覆盖 transcript 合成的 0 占位。 */

export function seedUsage(
  this: ConversationTopicPublisherMethodsContext,
  seed: SessionUsageSeed,
): void {
  this.projection.seedUsage(seed);
  this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
}

/** cold hydration 的 store-verified subagent manifest，不产 delta。 */

export function seedSubagents(
  this: ConversationTopicPublisherMethodsContext,
  seed: SessionSubagentsSeed,
): void {
  this.projection.seedSubagents(seed);
  this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
}

/**
 * 下发用快照：rows 只带尾部窗口（snapshotTailWindowRows），
 * totalCount/firstRowId 保留全序口径——客户端以 `window[0].rowId === firstRowId`
 * 判定已到顶，更早历史经 rows/range 游标拉取。投影内部快照保持全量
 * （rows/range 数据源 + findRow/messageId 锚点都依赖它），只在打帧边界截断。
 */

export function getWireSnapshot(
  this: ConversationTopicPublisherMethodsContext,
  snapshot = this.projection.getSnapshot(),
): ConversationSnapshot {
  return this.getWireSnapshotForProfile(DELIVERY_PROFILES.continuous, snapshot);
}

export function getWireSnapshotForProfile(
  this: ConversationTopicPublisherMethodsContext,
  profile: DeliveryProfile,
  snapshot = this.projection.getSnapshot(),
): ConversationSnapshot {
  const visibleRows = filterConversationRowsForProfile(snapshot.rows.window, profile);
  const visibleSnapshot: ConversationSnapshot = {
    ...snapshot,
    rows: {
      ...snapshot.rows,
      window: visibleRows,
      totalCount: visibleRows.length,
      firstRowId: visibleRows[0]?.rowId ?? null,
    },
  };
  const limit = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
  if (visibleRows.length <= limit) return visibleSnapshot;
  return {
    ...visibleSnapshot,
    rows: { ...visibleSnapshot.rows, window: visibleRows.slice(-limit) },
  };
}

/**
 * 一个订阅者的快照帧：profile 决定行可见性，能力位决定 `workflowRuns` 发全量还是旧界。
 *
 * 快照与增量必须同一档：一个收着旧界整键 patch 的客户端，如果快照里突然来了 512 个节点，
 * 它的 `.max(256)` 会让**整帧**解析失败（已知键上的解析错误不会只剥掉一个键）。
 */

export function getWireSnapshotForSubscription(
  this: ConversationTopicPublisherMethodsContext,
  subscription: Subscription,
): ConversationSnapshot {
  const snapshot = this.getWireSnapshotForProfile(subscription.profile);
  if (subscription.workflowRunDeltas || snapshot.workflowRuns === undefined) return snapshot;
  const workflowRuns = clampWorkflowRunsForLegacy(snapshot.workflowRuns);
  return workflowRuns === snapshot.workflowRuns ? snapshot : { ...snapshot, workflowRuns };
}

/**
 * 一批 delta 的**每订阅者**编码：profile 过滤 + 旧消费者的整键折叠。
 *
 * 折叠取的是**当前**投影状态，所以恢复回放上历史增量会折成终态——中间态被跳过，终态一致，
 * 与 coalesce 的既有行为同规（conversation-workflow-run-deltas.ts 的文件头）。
 */

export function encodeDeltasForSubscription(
  this: ConversationTopicPublisherMethodsContext,
  deltas: readonly ConversationDelta[],
  subscription: Subscription,
): readonly ConversationDelta[] {
  const filtered = filterConversationDeltasForProfile(deltas, subscription.profile);
  if (subscription.workflowRunDeltas) return filtered;
  return encodeConversationDeltasForLegacy(filtered, this.projection.getSnapshot().workflowRuns);
}

/**
 * 输入 admission 的候选 projection：用完整 QueueItem 表达同一份 intent，覆盖文本与附件引用。
 * QueueItem 元数据不小于立即启动后的 user row，因此通过此闸门的输入不会在后续首次
 * snapshot 才变成不可传输。此方法只读，不写 admission / event log。
 */

export function measureInputAdmissionProjectionBytes(
  this: ConversationTopicPublisherMethodsContext,
  envelope: CommandEnvelope,
  admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
): number | null {
  const raw = envelope.payload as {
    text?: string;
    displayText?: string;
    attachments?: QueueItem["attachments"];
    firstInput?: { text: string; attachments?: QueueItem["attachments"] };
  };
  const input = envelope.type === "createSession" ? raw.firstInput : raw;
  if (
    !input ||
    (envelope.type !== "createSession" &&
      envelope.type !== "sendText" &&
      envelope.type !== "sendGoalCommand" &&
      envelope.type !== "compact")
  ) {
    return null;
  }
  const snapshot = this.projection.getSnapshot();
  const queueItem: QueueItem = {
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind:
      envelope.type === "compact"
        ? "compact"
        : envelope.type === "sendGoalCommand"
          ? "sendGoalCommand"
          : "sendText",
    text:
      envelope.type === "compact"
        ? "/compact"
        : envelope.type === "sendGoalCommand"
          ? raw.displayText?.trim() || `/goal ${(input.text ?? "").trim()}`
          : (input.text ?? ""),
    attachments: input.attachments ?? [],
    delivery: { requested: "queue", admitted: "queue" },
    order: {
      admissionSeq: admission.admissionSeq,
      queuePosition: snapshot.queue.items.length,
    },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: admission.admittedAt,
  };
  const candidate: ConversationSnapshot = {
    ...snapshot,
    queue: { ...snapshot.queue, items: [...snapshot.queue.items, queueItem] },
  };
  return this.measureWireSnapshotBytes(this.getWireSnapshot(candidate));
}

export function measureWireSnapshotBytes(
  this: ConversationTopicPublisherMethodsContext,
  snapshot: ConversationSnapshot,
): number {
  // subscriptionId/时间/seq 使用本 publisher 可产生的最长常规表示，确保测量不是只算 payload。
  const frame: ConversationTopicFrame = {
    topic: this.topic,
    subscriptionId: `sub-${this.logEpoch}-${Number.MAX_SAFE_INTEGER}`,
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: Number.MAX_SAFE_INTEGER,
    payload: { kind: "snapshot", snapshot },
  };
  return utf8JsonByteLength(frame);
}
