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

import type { ConversationTopicFrame, SubscribeAck } from "@zcode/shared/zcode-protocol-v4";

import { DELIVERY_PROFILES, coalesceConversationDeltas } from "@zcode/shared/zcode-protocol-v4";

import type { TopicFrameReservation } from "./topic-frame-reservation.js";

import type { ConversationTopicPublisherMethodsContext } from "./topic-publisher-context.js";
import type {
  ConversationSubscribeParams,
  ConversationSubscribeResult,
  Subscription,
} from "./topic-publisher-support.js";
/**
 * 订阅裁决：base.logEpoch 匹配且 base.seq 在保留窗内 → resume，
 * 否则 snapshot。同 connectionId 重订阅 = 替换旧订阅并清其 flush buffer。
 */

export function subscribe(
  this: ConversationTopicPublisherMethodsContext,
  params: ConversationSubscribeParams,
): ConversationSubscribeResult {
  const result = this.subscribeReserved(params);
  result.reservation?.commit();
  return result;
}

/** 生产 gateway 入口：初始帧也必须等 physical batch 全接受才 commit。 */

export function subscribeReserved(
  this: ConversationTopicPublisherMethodsContext,
  params: ConversationSubscribeParams,
): ConversationSubscribeResult {
  const previousId = this.subscriptionIdByConnection.get(params.connectionId);
  const previousSubscription =
    previousId === undefined ? undefined : this.subscriptions.get(previousId);
  if (previousId !== undefined) this.subscriptions.delete(previousId);

  const profile = DELIVERY_PROFILES[params.deliveryProfile ?? "replayable"];
  const subscription: Subscription = {
    subscriptionId: `sub-${this.logEpoch}-${this.nextSubscriptionSerial++}`,
    connectionId: params.connectionId,
    profile,
    workflowRunDeltas: params.workflowRunDeltas === true,
    buffer: [],
    bufferBytes: 0,
    resyncRequired: false,
    sentSeq: 0,
    inFlight: null,
    nextLogicalFrameOrdinal: 1,
  };
  this.subscriptions.set(subscription.subscriptionId, subscription);
  this.subscriptionIdByConnection.set(params.connectionId, subscription.subscriptionId);
  const rollback = (): boolean => {
    // initial reservation commit 后 replacement 已 admission，禁止迟到 rollback。
    if (
      subscription.inFlight === null ||
      this.subscriptions.get(subscription.subscriptionId) !== subscription ||
      this.subscriptionIdByConnection.get(params.connectionId) !== subscription.subscriptionId
    ) {
      return false;
    }
    this.subscriptions.delete(subscription.subscriptionId);
    if (previousId !== undefined && previousSubscription) {
      this.subscriptions.set(previousId, previousSubscription);
      this.subscriptionIdByConnection.set(params.connectionId, previousId);
    } else {
      this.subscriptionIdByConnection.delete(params.connectionId);
    }
    return true;
  };

  const base = params.base;
  const resumable =
    base !== undefined &&
    base.logEpoch === this.logEpoch &&
    base.seq >= this.floorSeq &&
    base.seq <= this.currentSeq;

  if (!resumable) {
    const reservation = this.reserveFrame(
      subscription,
      {
        ...this.frameShell(subscription),
        fromSeq: 0,
        toSeq: this.currentSeq,
        payload: {
          kind: "snapshot",
          snapshot: this.getWireSnapshotForSubscription(subscription),
        },
      },
      false,
      "initial",
    );
    return this.subscribeResult(this.ackFor(subscription, "snapshot"), reservation, rollback);
  }

  // resume：保留窗内 (base.seq, current] 重放，与在线续流同一条 filter→编码→coalesce 管线。
  const replay = coalesceConversationDeltas(
    this.encodeDeltasForSubscription(
      this.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
      subscription,
    ),
  );
  if (base.seq === this.currentSeq) {
    subscription.sentSeq = base.seq;
    return this.subscribeResult(this.ackFor(subscription, "resume"), null, () => false);
  }
  subscription.sentSeq = base.seq;
  const reservation = this.reserveFrame(
    subscription,
    {
      ...this.frameShell(subscription),
      fromSeq: base.seq,
      toSeq: this.currentSeq,
      payload: { kind: "deltas", deltas: replay },
    },
    false,
    "initial",
  );
  return this.subscribeResult(this.ackFor(subscription, "resume"), reservation, rollback);
}

export function unsubscribe(
  this: ConversationTopicPublisherMethodsContext,
  subscriptionId: string,
  connectionId?: string,
): void {
  const subscription = this.subscriptions.get(subscriptionId);
  if (!subscription) return;
  if (connectionId !== undefined && subscription.connectionId !== connectionId) {
    return;
  }
  this.subscriptions.delete(subscriptionId);
  if (this.subscriptionIdByConnection.get(subscription.connectionId) === subscriptionId) {
    this.subscriptionIdByConnection.delete(subscription.connectionId);
  }
}

export function hasSubscription(
  this: ConversationTopicPublisherMethodsContext,
  subscriptionId: string,
  connectionId?: string,
): boolean {
  const subscription = this.subscriptions.get(subscriptionId);
  return Boolean(
    subscription && (connectionId === undefined || subscription.connectionId === connectionId),
  );
}

/** Resident 回收判定：仍有任一订阅者时该会话不可被去激活。 */

export function hasSubscribers(this: ConversationTopicPublisherMethodsContext): boolean {
  return this.subscriptions.size > 0;
}

export function connectionIdForSubscription(
  this: ConversationTopicPublisherMethodsContext,
  subscriptionId: string,
): string | null {
  return this.subscriptions.get(subscriptionId)?.connectionId ?? null;
}

export function subscribeResult(
  this: ConversationTopicPublisherMethodsContext,
  ack: SubscribeAck,
  reservation: TopicFrameReservation<ConversationTopicFrame> | null,
  rollback: () => boolean,
): ConversationSubscribeResult {
  return {
    ack,
    reservation,
    rollback,
    // 兼容旧 publisher 单测：读 frame 即表示本地 transport 已接受。
    // 生产 gateway 只读 reservation，不会触发该 getter。
    get frame() {
      reservation?.commit();
      return reservation?.frame ?? null;
    },
  };
}
