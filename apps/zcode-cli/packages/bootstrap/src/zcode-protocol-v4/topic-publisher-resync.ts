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

import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";

import { coalesceConversationDeltas } from "@zcode/shared/zcode-protocol-v4";

import type { TopicFrameReservation } from "./topic-frame-reservation.js";

import { appendConversationSubscriberBuffer } from "./topic-publisher-support.js";

import type { ConversationTopicPublisherMethodsContext } from "./topic-publisher-context.js";
import type {
  ConversationResyncRequest,
  ConversationSubscribeResult,
  Subscription,
} from "./topic-publisher-support.js";
/**
 * 活跃订阅 same-sub 恢复：客户端 base 是唯一恢复起点，不能拿 sentSeq
 * 猜客户端已应用到哪里。新 recovery admission 会作废旧 reservation；迟到 commit
 * 因 inFlight 身份不再匹配而返回 false。
 */

export function resyncReserved(
  this: ConversationTopicPublisherMethodsContext,
  subscriptionId: string,
  request: ConversationResyncRequest,
): ConversationSubscribeResult | null {
  const subscription = this.subscriptions.get(subscriptionId);
  if (!subscription) return null;

  const previous = {
    buffer: subscription.buffer,
    bufferBytes: subscription.bufferBytes,
    resyncRequired: subscription.resyncRequired,
    sentSeq: subscription.sentSeq,
    inFlight: subscription.inFlight,
  };

  // 旧 resync 会先 commit 当前 reservation，再基于服务端 sentSeq 发 snapshot，
  // 这会把客户端未收到的帧误记为已送达。same-sub recovery 必须直接 supersede。
  subscription.inFlight = null;
  subscription.buffer = [];
  subscription.bufferBytes = 0;
  subscription.resyncRequired = false;

  const base = request.base;
  const resumable =
    !request.forceSnapshot &&
    base !== null &&
    base.logEpoch === this.logEpoch &&
    base.seq >= this.floorSeq &&
    base.seq <= this.currentSeq;

  if (!resumable) {
    subscription.sentSeq = 0;
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
      "recovery",
    );
    return this.subscribeResult(
      this.ackFor(subscription, "snapshot"),
      reservation,
      this.resyncRollback(subscription, reservation, previous),
    );
  }

  subscription.sentSeq = base.seq;
  const replay = coalesceConversationDeltas(
    this.encodeDeltasForSubscription(
      this.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
      subscription,
    ),
  );
  const reservation = this.reserveFrame(
    subscription,
    {
      ...this.frameShell(subscription),
      fromSeq: base.seq,
      toSeq: this.currentSeq,
      payload: { kind: "deltas", deltas: replay },
    },
    false,
    "recovery",
  );
  return this.subscribeResult(
    this.ackFor(subscription, "resume"),
    reservation,
    this.resyncRollback(subscription, reservation, previous),
  );
}

export function resyncRollback(
  this: ConversationTopicPublisherMethodsContext,
  subscription: Subscription,
  reservation: TopicFrameReservation<ConversationTopicFrame>,
  previous: Pick<
    Subscription,
    "buffer" | "bufferBytes" | "resyncRequired" | "sentSeq" | "inFlight"
  >,
): () => boolean {
  let rolledBack = false;
  return (): boolean => {
    if (rolledBack) return true;
    if (
      this.subscriptions.get(subscription.subscriptionId) !== subscription ||
      subscription.inFlight !== reservation
    ) {
      return false;
    }
    const recoveryBuffer = subscription.buffer;
    const recoveryResyncRequired = subscription.resyncRequired;
    const merged = appendConversationSubscriberBuffer(
      previous.buffer,
      recoveryBuffer,
      this.subscriberBufferLimits(),
    );
    if (merged.kind === "overflow" || previous.resyncRequired || recoveryResyncRequired) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
    } else {
      subscription.buffer = merged.deltas;
      subscription.bufferBytes = merged.encodedBytes;
      subscription.resyncRequired = false;
    }
    subscription.sentSeq = previous.sentSeq;
    subscription.inFlight = previous.inFlight;
    rolledBack = true;
    return true;
  };
}

/** 溢出降级（05 §两级背压）：清缓冲、回发 snapshot 帧重对齐。 */

export function resync(
  this: ConversationTopicPublisherMethodsContext,
  subscriptionId: string,
): ConversationTopicFrame | null {
  const reservation = this.resyncReserved(subscriptionId, {
    base: null,
    forceSnapshot: true,
  })?.reservation;
  if (!reservation || !reservation.commit()) return null;
  return reservation.frame;
}
