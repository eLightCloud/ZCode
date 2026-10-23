// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type { SessionEvent } from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）

import type { ConversationDelta, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

import type {
  SessionConfigSeed,
  SessionSubagentsSeed,
  SessionUsageSeed,
} from "./product-projection-contract.js";

import {
  cloneSparseModelSelection,
  sameSparseModelSelection,
} from "./product-projection-model-values.js";

import type { ProductProjectionContext } from "./projection-context.js";
/**
 * config 种子注入。
 *
 * 初始快照 config 曾写死空 provider/model +
 * mode="build"，而 ModelSelected 只在 switchModelConfig 后补发、SessionCreated 刻意
 * 不产 delta——runtime 真值（启动默认模型/项目持久化 mode/历史会话上次选型）从头到尾
 * 进不了投影。后果：① 新会话模型选择器显示空；② 项目持久化 mode=yolo 时 UI 显示
 * build，点 yolo 命中 handler 同值 no-op（判的是 runtime 真值），UI 永远无法收敛——
 * 打破了「revision 不变 ⇔ 无状态变化」的 CAS 不变量。
 *
 * 为什么这么修：种子直改 snapshot.config，不产 delta、不递增 revision/seq——
 * draft「无可见 delta」裁决不被破坏；事件触碰过的区块跳过（重放序
 * 在种子之后时日志值优先）。幂等：可在 ensurePublisher / hydration 后重复调用。
 */

export function seedConfig(this: ProductProjectionContext, seed: SessionConfigSeed): void {
  const config = { ...this.snapshot.config };
  let changed = false;
  if (!config.permissionGrant && seed.permissionGrant) {
    config.permissionGrant = seed.permissionGrant;
    changed = true;
  }
  if (!this.configModelTouchedByEvent) {
    if (
      Object.hasOwn(seed, "modelSelection") &&
      !sameSparseModelSelection(config.modelSelection, seed.modelSelection)
    ) {
      // 恢复的空选择也有明确语义，不能因为 falsy 而保留历史事件里的旧选型。
      config.modelSelection = seed.modelSelection
        ? cloneSparseModelSelection(seed.modelSelection)
        : undefined;
      changed = true;
    }
    if (seed.provider !== undefined && config.provider !== seed.provider) {
      config.provider = seed.provider;
      changed = true;
    }
    if (seed.model !== undefined && config.model !== seed.model) {
      config.model = seed.model;
      changed = true;
    }
    if (seed.thought !== undefined && config.thought !== seed.thought) {
      config.thought = seed.thought;
      changed = true;
    }
  }
  const seedThoughtLevels = seed.thoughtLevels;
  if (
    !this.configThoughtLevelsTouchedByEvent &&
    seedThoughtLevels !== undefined &&
    (config.thoughtLevels.length !== seedThoughtLevels.length ||
      config.thoughtLevels.some((value, index) => value !== seedThoughtLevels[index]))
  ) {
    config.thoughtLevels = [...seedThoughtLevels];
    changed = true;
  }
  if (!this.configModeTouchedByEvent && seed.mode && config.mode !== seed.mode) {
    config.mode = seed.mode;
    changed = true;
  }
  if (
    !this.configModeTouchedByEvent &&
    seed.planEnabled !== undefined &&
    config.planEnabled !== seed.planEnabled
  ) {
    config.planEnabled = seed.planEnabled;
    changed = true;
  }
  if (changed) {
    this.snapshot = { ...this.snapshot, config };
  }
}

/**
 * 导入分享上下文的来源只读种子。
 *
 * shared_context 是 provider-only message，不应物化为用户气泡；来源标记通过
 * snapshot additive 字段下发，供 Desktop 在打开新会话后显示持久提示。该字段
 * 不属于 conversation rows，也不递增 revision/seq，避免伪造一轮对话。
 */

export function seedSharedContextImport(
  this: ProductProjectionContext,
  source: ConversationSnapshot["sharedContextImport"] | null | undefined,
): void {
  const title = source?.title.trim();
  if (!title) return;
  if (
    this.snapshot.sharedContextImport?.title === title &&
    (source as { contextId?: string }).contextId ===
      (this.snapshot.sharedContextImport as { contextId?: string }).contextId &&
    (source as { status?: string }).status ===
      (this.snapshot.sharedContextImport as { status?: string }).status
  ) {
    return;
  }
  this.snapshot = {
    ...this.snapshot,
    sharedContextImport: {
      ...source,
      title,
    },
  };
}

export function seedUsage(this: ProductProjectionContext, seed: SessionUsageSeed): void {
  const current = this.snapshot.usage;
  const currentContextWindow = current.contextWindow;
  if (currentContextWindow) {
    this.contextWindowState.usedTokens = currentContextWindow.usedTokens;
  }
  // 未知容量也有内部用量事实；迟到的恢复种子不能覆盖真实 ModelComplete/Compact 水位。
  if (this.contextWindowState.usedTokens > 0) {
    return;
  }
  const seededContextWindow = seed.contextWindow;
  if (!Number.isFinite(seededContextWindow.usedTokens) || seededContextWindow.usedTokens <= 0) {
    return;
  }
  const cumulative = {
    inputTokens: seed.cumulative?.inputTokens ?? current.cumulative.inputTokens,
    outputTokens: seed.cumulative?.outputTokens ?? current.cumulative.outputTokens,
    cacheReadTokens: seed.cumulative?.cacheReadTokens ?? current.cumulative.cacheReadTokens,
    cacheWriteTokens: seed.cumulative?.cacheWriteTokens ?? current.cumulative.cacheWriteTokens,
  };
  if (this.contextWindowState.touchedByEvent) {
    // 同类守卫：显式 ModelSelected.contextWindow（含 null）是日志权威容量，
    // hydration seed 只能补回更准确的 token 事实，不得覆盖 maxTokens 或重新显示 null。
    this.contextWindowState.usedTokens = seededContextWindow.usedTokens;
    this.snapshot = {
      ...this.snapshot,
      usage: {
        contextWindow: currentContextWindow
          ? {
              ...currentContextWindow,
              usedTokens: seededContextWindow.usedTokens,
            }
          : null,
        cumulative,
      },
    };
    return;
  }
  if (
    seededContextWindow.maxTokens !== null &&
    (!Number.isFinite(seededContextWindow.maxTokens) || seededContextWindow.maxTokens <= 0)
  ) {
    return;
  }

  // 合成历史事件只有零用量占位；种子补真实水位，未知容量不妨碍内部保留 token。
  this.contextWindowState.usedTokens = seededContextWindow.usedTokens;
  this.contextWindowState.maxTokens = seededContextWindow.maxTokens;
  this.snapshot = {
    ...this.snapshot,
    usage: {
      contextWindow:
        seededContextWindow.maxTokens === null
          ? null
          : { ...seededContextWindow, maxTokens: seededContextWindow.maxTokens },
      cumulative,
    },
  };
}

/**
 * 冷恢复的 subagent store 校验种子。transcript 可以恢复可见 row，但只有 session
 * store 能证明 child 已持久化为 subagent_child；因此在 candidate publisher 发布前
 * 用该种子整体替换 manifest，旧版本遗留的幽灵 child 不得进入 UI 权威态。
 */

export function seedSubagents(this: ProductProjectionContext, seed: SessionSubagentsSeed): void {
  const childSessionIds = [...new Set(seed.childSessionIds)];
  const allowed = new Set(childSessionIds);
  this.invalidSubagentChildSessionIds = new Set(
    this.snapshot.rows.window.flatMap((row) =>
      row.kind === "subagent" && row.childSessionId && !allowed.has(row.childSessionId)
        ? [row.childSessionId]
        : [],
    ),
  );
  const running = seed.running.filter((item) => allowed.has(item.childSessionId));
  this.snapshot = {
    ...this.snapshot,
    subagents: {
      // 非空 cold manifest 必须至少从 1 开始；renderer 用 0 区分尚未建立权威态，
      // 否则旧 session 的 stateRevision=0 会让 child tab 失效同步被永久跳过。
      revision: Math.max(childSessionIds.length > 0 ? 1 : 0, Math.floor(seed.revision)),
      childSessionIds,
      running,
      endedTotal: Math.max(0, childSessionIds.length - running.length),
    },
  };
}

// ── 生命周期 ──

export function onSessionCreated(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { contextWindow?: number };
  this.contextWindowState.maxTokens = payload.contextWindow ?? null;
  // draft 语义：会话实体已存在、无 row；phase 保持 draft，无可见 delta。
  return [];
}

// renameSession / 自动标题：SessionTitleUpdated(title, source) → 更新 meta。
// custom（用户重命名）优先级最高，已 custom 后不再被 generated 覆盖（与 core titleSource 一致）。

export function onSessionTitleUpdated(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    title?: string;
    source?: string;
  };
  const title = payload.title ?? "";
  // core 的 titleSource 有 4 值（default/first_input/generated/custom）；投影 meta 归一为
  // default/generated/custom（first_input 归入 generated：都属"非用户显式"）。
  const source: "default" | "generated" | "custom" =
    payload.source === "custom" ? "custom" : payload.source === "default" ? "default" : "generated";
  const prev = this.snapshot.meta;
  if (prev.titleSource === "custom" && source === "generated") return [];
  if (prev.title === title && prev.titleSource === source) return [];
  return [
    {
      op: "state.updated",
      patch: { meta: { title, titleSource: source } },
    },
  ];
}

/**
 * switchCollaborationMode：SessionModeChanged → config.mode。
 * 事件来源覆盖命令面（source=command）与 plan 工具路径（enterPlanMode/exitPlanMode，
 * source=tool）——两条路径共用这条投影，UI 的模式选择器因此也能跟随工具驱动的模式切换。
 */

export function onSessionModeChanged(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    mode?: string;
    planEnabled?: boolean;
    source?: string;
    toolCallId?: string;
    permissionGrant?: { interactionId: string; queueItemIds: string[] };
  };
  const mode = typeof payload.mode === "string" ? payload.mode : "";
  // 日志事件触碰过 mode 后，种子不再覆盖（同值 return 也算触碰——日志有权威值）。
  if (mode) this.configModeTouchedByEvent = true;
  if (!mode) return [];
  const planEnabled = payload.planEnabled ?? mode === "plan";
  const planTransition =
    payload.source === "tool" && payload.toolCallId
      ? { toolCallId: payload.toolCallId, planEnabled }
      : this.snapshot.config.planTransition;
  if (
    this.snapshot.config.mode === mode &&
    this.snapshot.config.planEnabled === planEnabled &&
    planTransition === this.snapshot.config.planTransition &&
    !payload.permissionGrant
  )
    return [];
  return [
    {
      op: "state.updated",
      patch: {
        ...(payload.permissionGrant
          ? this.queuePatch({
              ...this.snapshot.queue,
              items: this.snapshot.queue.items.map((item) =>
                payload.permissionGrant!.queueItemIds.includes(item.queueItemId)
                  ? { ...item, mode: "yolo" as const }
                  : item,
              ),
            })
          : {}),
        config: {
          ...this.snapshot.config,
          mode,
          planEnabled,
          planTransition,
          ...(payload.permissionGrant
            ? { permissionGrant: { interactionId: payload.permissionGrant.interactionId } }
            : {}),
        },
      },
    },
  ];
}
