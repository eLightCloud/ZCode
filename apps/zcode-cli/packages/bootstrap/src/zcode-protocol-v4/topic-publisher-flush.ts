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
  ConversationTopicFrame,
  SubscribeAck,
  TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";

import type { TopicFrameReservation } from "./topic-frame-reservation.js";

import type { ConversationTopicPublisherMethodsContext } from "./topic-publisher-context.js";
import type {
  ConversationSubscriberBufferLimits,
  Subscription,
} from "./topic-publisher-support.js";
/**
 * 排空一个订阅者的 flush buffer 打成一帧（宿主按 flushWindowMs 驱动）。
 * 无新内容返回 null；帧区间 (sentSeq, currentSeq] 覆盖中途被过滤掉的 seq，
 * 保证客户端 `frame.fromSeq === store.seq` 的连续性判定不受 profile 过滤影响。
 */

export function reserveFlush(
  this: ConversationTopicPublisherMethodsContext,
  subscriptionId: string,
): TopicFrameReservation<ConversationTopicFrame> | null {
  const subscription = this.subscriptions.get(subscriptionId);
  if (!subscription) return null;
  if (subscription.inFlight) return subscription.inFlight;
  if (subscription.resyncRequired) {
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    return this.reserveFrame(
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
      true,
      "online",
    );
  }
  if (subscription.buffer.length === 0 && subscription.sentSeq === this.currentSeq) {
    return null;
  }
  const deltas = subscription.buffer;
  const frame: ConversationTopicFrame = {
    ...this.frameShell(subscription),
    fromSeq: subscription.sentSeq,
    toSeq: this.currentSeq,
    payload: { kind: "deltas", deltas },
  };
  subscription.buffer = [];
  subscription.bufferBytes = 0;
  return this.reserveFrame(subscription, frame, false, "online");
}

/** 旧单测便利面；生产 gateway 必须 reserve 后在 emit-all 成功才 commit。 */

export function flush(
  this: ConversationTopicPublisherMethodsContext,
  subscriptionId: string,
): ConversationTopicFrame | null {
  const reservation = this.reserveFlush(subscriptionId);
  if (!reservation || !reservation.commit()) return null;
  return reservation.frame;
}

export function subscriberBufferLimits(
  this: ConversationTopicPublisherMethodsContext,
): ConversationSubscriberBufferLimits {
  return {
    maxOps: this.subscriberBufferMaxOps,
    maxBytes: this.subscriberBufferMaxBytes,
    snapshotBytesUpperBound: this.wireSnapshotBytesUpperBound,
  };
}

export function reserveFrame(
  this: ConversationTopicPublisherMethodsContext,
  subscription: Subscription,
  frame: ConversationTopicFrame,
  snapshotRecovery: boolean,
  deliveryKind: TopicFrameDeliveryKind,
): TopicFrameReservation<ConversationTopicFrame> {
  let committed = false;
  const reservation: TopicFrameReservation<ConversationTopicFrame> = {
    deliveryKind,
    logicalFrameId: `${subscription.subscriptionId}-lf-${this.nextLogicalFrameSerial++}`,
    logicalFrameOrdinal: subscription.nextLogicalFrameOrdinal++,
    frame,
    commit: () => {
      if (committed) return true;
      if (
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        subscription.inFlight !== reservation
      ) {
        return false;
      }
      subscription.sentSeq = frame.toSeq;
      subscription.inFlight = null;
      if (snapshotRecovery) {
        // snapshot 在途时 resyncRequired 会停止收 delta。
        // 若权威水位又推进，下一 reservation 必须再发最新 snapshot。
        subscription.resyncRequired = this.currentSeq > frame.toSeq;
      }
      committed = true;
      return true;
    },
  };
  subscription.inFlight = reservation;
  return reservation;
}

export function ackFor(
  this: ConversationTopicPublisherMethodsContext,
  subscription: Subscription,
  mode: SubscribeAck["mode"],
): SubscribeAck {
  return {
    subscriptionId: subscription.subscriptionId,
    mode,
    logEpoch: this.logEpoch,
  };
}

export function frameShell(
  this: ConversationTopicPublisherMethodsContext,
  subscription: Subscription,
): Pick<ConversationTopicFrame, "topic" | "subscriptionId" | "sentAt"> {
  return {
    topic: this.topic,
    subscriptionId: subscription.subscriptionId,
    sentAt: this.now(),
  };
}
