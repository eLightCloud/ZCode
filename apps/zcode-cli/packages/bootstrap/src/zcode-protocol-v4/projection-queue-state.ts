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
  SessionInputPromotedPayload,
  TurnSteerDiscardedPayload,
} from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）

import type { ConversationDelta, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

import { computeAvailability, computeInputRouting } from "./projection-state.js";

import type { ProductProjectionContext } from "./projection-context.js";
export function onTurnSteerDiscarded(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDiscardedPayload;
  return this.removeQueueItems(payload.pendingInputIds);
}

export function onSessionInputPromoted(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as SessionInputPromotedPayload;
  // sendQueuedNow 启动成功后，显式 TurnSteerDiscarded(promoted)
  // 可能在进程/链路边界丢失，使 UI 永久留下 promoting 幽灵项。
  // SessionInputPromoted 只在 user message + session_input 同事务提交后产生，
  // 因此它才是可以安全移除 queue 投影的 durable commit signal。
  return this.removeQueueItems([payload.pendingInputId]);
}

/** v4 queue 重排：按 orderedPendingInputIds 重排 queue rows（未列出的项保持相对顺序追加）。 */

export function onTurnSteerReordered(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { orderedPendingInputIds?: string[] };
  const order = payload.orderedPendingInputIds ?? [];
  const byId = new Map(this.snapshot.queue.items.map((item) => [item.queueItemId, item]));
  const ordered = order
    .map((id) => byId.get(id))
    .filter((item): item is (typeof this.snapshot.queue.items)[number] => item !== undefined);
  // 未在 order 里出现的项（防丢）追加保持原相对序。
  const orderedIds = new Set(order);
  const rest = this.snapshot.queue.items.filter((item) => !orderedIds.has(item.queueItemId));
  const reordered = [...ordered, ...rest];
  const items = reordered.map((item, index) =>
    item.order.queuePosition === index
      ? item
      : { ...item, order: { ...item.order, queuePosition: index } },
  );
  // 顺序无变化则不产 delta（幂等）。
  if (
    items.length === this.snapshot.queue.items.length &&
    items.every((item, index) => item === this.snapshot.queue.items[index])
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: this.queuePatch({ ...this.snapshot.queue, items }),
    },
  ];
}

// setAutoDrain：queue.autoDrain 授权位翻转。autoDrain 影响 held 派生
// （heldQueueInputRequiresChoice）与 A 区可用性 → 走 queuePatch 统一重算。

export function onQueueAutoDrainChanged(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { autoDrain?: boolean };
  const autoDrain = payload.autoDrain ?? true;
  if (
    this.snapshot.queue.autoDrain === autoDrain &&
    (autoDrain || this.snapshot.queue.pauseReason === "manual")
  ) {
    return [];
  }
  const queue = { ...this.snapshot.queue, autoDrain };
  if (autoDrain) {
    delete queue.pauseReason;
  } else {
    queue.pauseReason = "manual";
  }
  return [
    {
      op: "state.updated",
      patch: this.queuePatch(queue),
    },
  ];
}

// setFollowupMode：config.followupMode 翻转。followupMode 是 running 时
// enqueue vs guide 的路由授权位（computeInputRouting）→ 改 config 后同步重算 A 区。

export function onFollowupModeChanged(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { mode?: "queue" | "guide" };
  const mode: "queue" | "guide" = payload.mode === "guide" ? "guide" : "queue";
  if (this.snapshot.config.followupMode === mode) return [];
  const nextConfig: ConversationSnapshot["config"] = {
    ...this.snapshot.config,
    followupMode: mode,
  };
  const context = this.deriveContext({});
  return [
    {
      op: "state.updated",
      patch: {
        config: nextConfig,
        availability: computeAvailability(context),
        inputRouting: computeInputRouting(context, mode),
      },
    },
  ];
}

export function removeQueueItems(
  this: ProductProjectionContext,
  ids: readonly string[],
): ConversationDelta[] {
  const idSet = new Set(ids);
  for (const id of ids) this.deliveryByPendingInputId.delete(id);
  const items = this.snapshot.queue.items
    .filter((item) => !idSet.has(item.queueItemId))
    .map((item, index) =>
      item.order.queuePosition === index
        ? item
        : { ...item, order: { ...item.order, queuePosition: index } },
    );
  if (items.length === this.snapshot.queue.items.length) return [];
  return [
    {
      op: "state.updated",
      patch: this.queuePatch({ ...this.snapshot.queue, items }),
    },
  ];
}
