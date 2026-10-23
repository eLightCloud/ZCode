// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type {
  ModelCompletePayload,
  ModelSelectedPayload,
  ModelUsage,
  SessionEvent,
  TurnExecutionModelFallbackPayload,
} from "@zcode/contracts";

import { getModelUsageContextTokens } from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）

import type { ConversationDelta, UserInputRow } from "@zcode/shared/zcode-protocol-v4";

import { HYDRATION_TRACE_ID } from "./projection-state.js";

import {
  cloneSparseModelSelection,
  positiveInteger,
  sameSparseModelSelection,
} from "./product-projection-model-values.js";

import type { ProductProjectionContext } from "./projection-context.js";
export function onTurnExecutionModelFallback(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnExecutionModelFallbackPayload;
  // Bug 根因：fallback 会作废当前 assistant attempt，但旧投影只更新输入行元数据，仍把旧模型的
  // text/reasoning row 留在 streaming；原模型续流时这些内容会被误标 complete，缺少 text_start 时
  // 甚至直接拼到同一行。未定稿的 tool input 同样不会收到 tool_call，必须随废弃 attempt 一起收口。
  // 已提交执行的工具不在这里处理，它们由 core 的 tool_abandoned 事件收口。
  const discardedStreamDeltas = this.acceptsActiveModelEvent(event)
    ? [
        ...this.closeStreamingRows("interrupted"),
        ...this.closeOpenToolRows(event, "cancelled", (row) => row.status === "inputStreaming"),
      ]
    : [];
  // 卡过期与其他加速请求失败都投影到同一张加速输入行：fallbackAt 触发一次性提示，
  // fallbackReason 让 Renderer 区分“卡已到期”与“加速服务不可用”两种文案。
  const turnId = this.turnIdOf(event);
  const row = this.snapshot.rows.window.find(
    (candidate): candidate is UserInputRow =>
      candidate.kind === "userInput" &&
      // Bug 根因：cold hydration 会重建 product turnId，不能再拿 runtime turnId
      // 关联已持久化的输入；inputId/sourceCommandId 才是跨恢复稳定身份。
      (candidate.turnId === turnId ||
        (payload.inputId !== undefined && candidate.sourceCommandId === payload.inputId)) &&
      candidate.highspeed !== undefined,
  );
  if (!row?.highspeed) return discardedStreamDeltas;
  return [
    ...discardedStreamDeltas,
    {
      op: "row.upserted",
      row: {
        ...row,
        highspeed: {
          ...row.highspeed,
          fallbackAt: event.timestamp.getTime(),
          fallbackReason: payload.reason,
        },
      },
    },
  ];
}

// ── config / usage ──

export function onModelSelected(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as ModelSelectedPayload;
  // Bug 原因：把 fresh child 身份另存为 pending side state 后，原子投影 clone/adopt
  // 漏复制该字段，实时 marker 会消失。显式 null 直接复用模型基线表达 ∅→X，
  // 公共投影不再识别 Subagent 身份；后续选型只更新 config，不覆盖上一轮实际模型。
  if (payload.previousModelSelection === null) {
    this.lastTurnModel = { kind: "sourceLess" };
  }
  const prev = this.snapshot.config;
  const provider = payload.modelSelection.providerId;
  const model = payload.modelSelection.modelId;
  const thought =
    payload.effectiveReasoningLevel ?? payload.modelSelection.options?.reasoningLevel ?? "";
  const modelSelection = cloneSparseModelSelection(payload.modelSelection);
  const thoughtLevels = payload.supportedThoughtLevels
    ? [...payload.supportedThoughtLevels]
    : prev.thoughtLevels;
  const contextWindow =
    payload.contextWindow === null
      ? null
      : payload.contextWindow !== undefined
        ? positiveInteger(payload.contextWindow, 0) || undefined
        : undefined;
  // Bug 原因：旧事件只更新 config，runtime 虽已切到新模型，历史 usage 的 maxTokens
  // 仍停在源模型，直到下一次 ModelComplete 才偶然校准。窗口属于已应用模型能力，
  // 必须在同一个 ModelSelected 中提交；usedTokens 仍保留历史上下文事实。
  if (contextWindow !== undefined) {
    this.contextWindowState.touchedByEvent = true;
    this.contextWindowState.maxTokens =
      contextWindow !== null && contextWindow > 0 ? contextWindow : null;
  }
  const previousContextWindow = this.snapshot.usage.contextWindow;
  if (previousContextWindow) {
    this.contextWindowState.usedTokens = previousContextWindow.usedTokens;
  }
  const contextWindowChanged =
    contextWindow !== undefined &&
    (contextWindow === null
      ? previousContextWindow !== null
      : previousContextWindow === null || previousContextWindow.maxTokens !== contextWindow);
  // 日志事件触碰过模型选型后，种子不再覆盖（同值 return 也算触碰）。
  // 冷恢复合成的 ModelSelected（HYDRATION_TRACE_ID）例外：它只是从 message 事实
  // 重建历史选型供 modelChange marker 使用，不是权威选型动作；重放后 seedConfig
  // 仍以 runtime 真值（resume 已回写的上次/草稿选型）收口。
  if (String(event.traceId) !== HYDRATION_TRACE_ID) {
    this.configModelTouchedByEvent = true;
    if (payload.supportedThoughtLevels !== undefined) {
      this.configThoughtLevelsTouchedByEvent = true;
    }
  }
  // 选型事件只更新 config，不在选型时落 modelChange
  // marker——切换动作是意向，marker 归 onTurnStarted 按「与上一轮实际选型不同」
  // 裁决（见彼处注释与 Bug 背景）。
  const configChanged = !(
    prev.provider === provider &&
    prev.model === model &&
    sameSparseModelSelection(prev.modelSelection, modelSelection) &&
    prev.thought === thought &&
    prev.thoughtLevels.length === thoughtLevels.length &&
    prev.thoughtLevels.every((value, index) => value === thoughtLevels[index])
  );
  const modelTransition =
    payload.origin === "registryFallback" &&
    payload.previousModelSelection != null &&
    (payload.previousModelSelection.providerId !== provider ||
      payload.previousModelSelection.modelId !== model)
      ? {
          eventId: String(event.id),
          origin: payload.origin,
          from: {
            provider: payload.previousModelSelection.providerId,
            model: payload.previousModelSelection.modelId,
          },
          to: { provider, model },
        }
      : undefined;
  if (!configChanged && !contextWindowChanged && modelTransition === undefined) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: {
        ...(configChanged
          ? { config: { ...prev, modelSelection, provider, model, thought, thoughtLevels } }
          : {}),
        // Bug 原因：仅投影 config 会丢失“由 registry fallback 触发”的来源，
        // renderer 无法安全地区分自动恢复和显式/历史切换。保留事件 ID 与起止身份，
        // 具体 toast 仍只由客户端在实时 online delivery 边界触发。
        ...(modelTransition ? { modelTransition } : {}),
        ...(contextWindowChanged
          ? {
              usage: {
                ...this.snapshot.usage,
                // Bug 原因：null 是 registry 清除显式窗口的权威事件，必须清空整个
                // usage.contextWindow；字段缺失才保留旧事件兼容语义。
                contextWindow:
                  contextWindow === null
                    ? null
                    : previousContextWindow
                      ? { ...previousContextWindow, maxTokens: contextWindow }
                      : {
                          usedTokens: this.contextWindowState.usedTokens,
                          maxTokens: contextWindow,
                          autoCompactThresholdTokens: null,
                        },
              },
            }
          : {}),
      },
    },
  ];
}

export function onModelComplete(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as ModelCompletePayload;
  const retryClearDeltas = this.acceptsActiveModelEvent(event) ? this.setApiRetry(null) : [];
  // 与旧 reducer 同一裁决：只有主会话往返才能覆盖 context 水位。
  const isMainTurn =
    payload.querySource !== undefined
      ? payload.querySource === "main_turn"
      : payload.stopReason !== "tool_internal";
  if (isMainTurn) this.outputContinuationTextRowId = null;
  if (
    isMainTurn &&
    payload.stopReason?.trim().toLowerCase() === "length" &&
    payload.toolCallCount === 0
  ) {
    const lastVisibleRow = this.snapshot.rows.window.at(-1);
    if (
      lastVisibleRow?.kind === "assistantText" &&
      lastVisibleRow.turnId === this.turnIdOf(event) &&
      lastVisibleRow.state === "complete"
    ) {
      this.outputContinuationTextRowId = lastVisibleRow.rowId;
    }
  }
  // subagent ModelComplete 的 usage 仍不是主会话水位，但它携带的
  // fileChanges 是 child session 自己的 workspace 事实，必须独立投影到 child turn header。
  const supportsFileChangeSummary = isMainTurn || payload.querySource === "subagent";
  const usage = payload.usage as ModelUsage;
  const deltas: ConversationDelta[] = [];
  const turnId = this.turnIdOf(event);
  const headerRowId = this.turnHeaderRowIdByTurnId.get(turnId);
  const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
  if (headerRow?.kind === "turnHeader") {
    const fileChanges =
      supportsFileChangeSummary && payload.fileChanges && payload.fileChanges.files > 0
        ? {
            fileChanges: {
              additions: payload.fileChanges.additions,
              deletions: payload.fileChanges.deletions,
              files: payload.fileChanges.files,
              // Bug 根因：该条件对象随后与 headerRow 展开合并，TS 会把字面量扩宽为
              // string，导致 CLI 启动前构建无法满足 TurnFileChangeSummary 契约。
              state: "active" as const,
            },
          }
        : {};
    if (isMainTurn || "fileChanges" in fileChanges) {
      deltas.push({
        op: "row.upserted",
        row: {
          ...headerRow,
          ...fileChanges,
          // Bug 根因：Renderer 观察 running 快照的时机不可靠，continuous 可合并更新，
          // replayable 也可能首次恢复即终态。单 Turn token 必须在权威事件投影中累计。
          ...(isMainTurn
            ? { outputTokens: (headerRow.outputTokens ?? 0) + (usage.outputTokens ?? 0) }
            : {}),
        },
      });
    }
  }
  if (!isMainTurn) return [...deltas, ...retryClearDeltas];
  const usedTokens = getModelUsageContextTokens(usage) ?? 0;
  this.contextWindowState.usedTokens = usedTokens;
  const maxTokens = payload.contextWindow ?? this.contextWindowState.maxTokens;
  const cumulative = this.snapshot.usage.cumulative;
  deltas.push({
    op: "state.updated",
    patch: {
      usage: {
        // Bug 原因：registry 已显式清除窗口时，缺少 contextWindow 的 ModelComplete
        // 过去会用 0 重建对象，破坏未知容量语义。token 继续在侧状态和累计值中更新。
        contextWindow:
          maxTokens === null
            ? null
            : {
                usedTokens,
                maxTokens,
                autoCompactThresholdTokens:
                  this.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                ...(payload.cacheHit ? { cache: payload.cacheHit } : {}),
                ...(payload.contextUsageBreakdown && payload.contextUsageBreakdown.length > 0
                  ? { breakdown: payload.contextUsageBreakdown }
                  : {}),
              },
        cumulative: {
          inputTokens: cumulative.inputTokens + (usage.inputTokens ?? 0),
          outputTokens: cumulative.outputTokens + (usage.outputTokens ?? 0),
          cacheReadTokens: cumulative.cacheReadTokens + (usage.cacheReadTokens ?? 0),
          cacheWriteTokens: cumulative.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
        },
      },
    },
  });
  // ModelComplete 是缺少 network completed 事件时的成功兜底，不能让重试提示悬挂。
  deltas.push(...retryClearDeltas);
  return deltas;
}
