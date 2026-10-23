// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）

import type {
  ConversationSnapshot,
  GoalState,
  SessionControl,
  StatePatch,
} from "@zcode/shared/zcode-protocol-v4";

import { computeAvailability, computeInputRouting } from "./projection-state.js";

import type { ProductProjectionContext } from "./projection-context.js";
// ── 内部工具 ──

// goal 传 undefined = 不动 goal；传 null/对象 = 随本 patch 一并替换（availability 同源派生）。
// queue 传 undefined = 不动 queue；held 派生（heldQueueInputRequiresChoice）依赖
// queue.items.length + autoDrain，所以任何 control/goal/queue 变化都从同一处重算 A 区。

export function controlPatch(
  this: ProductProjectionContext,
  control: Partial<SessionControl>,
  goal?: GoalState | null,
  queue?: ConversationSnapshot["queue"],
): StatePatch {
  const next: SessionControl = { ...this.snapshot.control, ...control };
  const nextGoal = goal === undefined ? this.snapshot.goal : goal;
  const nextQueue = queue ?? this.snapshot.queue;
  const context = {
    phase: next.phase,
    goalStatus: nextGoal?.status ?? null,
    // compacting 不是独立 phase（封闭枚举），从 activeWorks 派生。
    compacting: next.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: next.activeWorks.some((work) => work.kind === "goalVerifier"),
    queueLength: nextQueue.items.length,
    autoDrain: nextQueue.autoDrain,
  };
  return {
    control: next,
    ...(goal === undefined ? {} : { goal }),
    ...(queue === undefined ? {} : { queue }),
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, this.snapshot.config.followupMode),
  };
}

// goal 单独变化时的 patch（availability 与 goal 同源，phase/activeWorks 不变）。

export function goalPatch(this: ProductProjectionContext, goal: GoalState | null): StatePatch {
  return {
    goal,
    availability: computeAvailability(this.deriveContext({ goal })),
  };
}

// queue 单独变化时的 patch：queue 长度/autoDrain 影响 held 派生 → 同步重算 A 区。

export function queuePatch(
  this: ProductProjectionContext,
  queue: ConversationSnapshot["queue"],
): StatePatch {
  const context = this.deriveContext({ queue });
  return {
    queue,
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, this.snapshot.config.followupMode),
  };
}

export function deriveContext(
  this: ProductProjectionContext,
  overrides: {
    goal?: GoalState | null;
    queue?: ConversationSnapshot["queue"];
  },
) {
  const goal = overrides.goal === undefined ? this.snapshot.goal : overrides.goal;
  const queue = overrides.queue ?? this.snapshot.queue;
  return {
    phase: this.snapshot.control.phase,
    goalStatus: goal?.status ?? null,
    compacting: this.snapshot.control.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: this.snapshot.control.activeWorks.some((work) => work.kind === "goalVerifier"),
    queueLength: queue.items.length,
    autoDrain: queue.autoDrain,
  };
}

export function isRunning(this: ProductProjectionContext): boolean {
  const phase = this.snapshot.control.phase;
  return phase === "running" || phase === "prewarming";
}
