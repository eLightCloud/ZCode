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

import type {
  ConversationDelta,
  TurnHeaderRow,
  TurnWorkSegment,
} from "@zcode/shared/zcode-protocol-v4";

import { buildTurnHeaderRow } from "./projection-rows.js";

import type { ProductProjectionContext } from "./projection-context.js";
/**
 * queue drain 边界 = product turn 边界（同一 runtimeTurn 内）。
 * 收口上一段 productTurn 的 header（工时按边界拆分，加和 = 总工时），
 * 映射 runtimeTurnId → 新 productTurnId，开新 turnHeader。
 */

export function splitProductTurn(
  this: ProductProjectionContext,
  event: SessionEvent,
  runtimeTurnId: string,
  promotedUserMessageId?: string,
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  const previousProductTurnId =
    this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
  const headerRowId = this.turnHeaderRowIdByTurnId.get(previousProductTurnId);
  const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
  if (headerRow?.kind === "turnHeader") {
    const endedAt = this.ms(event);
    deltas.push({
      op: "row.upserted",
      row: {
        ...headerRow,
        state: "completedSuccess",
        endedAt,
        activeMs: Math.max(
          0,
          endedAt - (this.currentProductTurnStartedAtMs ?? headerRow.startedAt),
        ),
        ...(headerRow.workSegments
          ? {
              workSegments: this.completeWorkSegments(headerRow.workSegments, endedAt),
            }
          : {}),
      },
    });
  }
  const ordinal = (this.productTurnSplitOrdinalByRuntimeTurnId.get(runtimeTurnId) ?? 0) + 1;
  this.productTurnSplitOrdinalByRuntimeTurnId.set(runtimeTurnId, ordinal);
  // 旧实现用 runtimeTurnId + 本次进程内 ordinal 造 productTurnId；
  // cold hydration 会改用 hydrate-turn-N，同一条 queue 输入恢复前后无法保持身份。
  // promotion 已产生持久 user messageId，新 product turn 必须直接使用该权威身份；
  // 只有 legacy drain 缺 messageId 时才保留 ordinal fallback。
  const productTurnId = promotedUserMessageId ?? `${runtimeTurnId}~q${ordinal}`;
  this.productTurnIdByRuntimeTurnId.set(runtimeTurnId, productTurnId);
  this.runtimeTurnIdByProductTurnId.set(productTurnId, runtimeTurnId);
  this.currentProductTurnStartedAtMs = this.ms(event);
  const header = buildTurnHeaderRow(this.rowBase(event, productTurnId, productTurnId), {
    turnNumber: 0,
    input: "",
  });
  this.turnHeaderRowIdByTurnId.set(productTurnId, header.rowId);
  deltas.push({ op: "row.appended", row: header });
  return deltas;
}

// 工时按边界拆分：drain 切过轮的 runtimeTurn，最后一段 productTurn 的工时
// = 最后一次边界到完成，不再用整段 runtime duration（否则两段加和超真实时长）。

export function activeMsForCompletion(
  this: ProductProjectionContext,
  event: SessionEvent,
  runtimeDuration?: number,
): number | undefined {
  const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
  // 稳定 user messageId 映射并不代表发生过 queue drain 切段；只有 split ordinal
  // 存在时才按边界时间计算最后一段工时。否则 cold 合成事件的展示时间戳跨度很小，
  // 会错误覆盖 transcript 已计算好的整轮 duration。
  if (!this.productTurnSplitOrdinalByRuntimeTurnId.has(runtimeTurnId)) return runtimeDuration;
  if (this.currentProductTurnStartedAtMs === null) return runtimeDuration;
  return Math.max(0, this.ms(event) - this.currentProductTurnStartedAtMs);
}

export function upsertTurnHeader(
  this: ProductProjectionContext,
  event: SessionEvent,
  state: "completedSuccess" | "completedInterrupted" | "failed",
  activeMs?: number,
  historyRoundCount?: number,
  highspeedTiming?: {
    modelDurationMs: number;
    toolDurationMs: number;
    otherDurationMs: number;
  },
): ConversationDelta[] {
  const row = this.turnHeaderForEvent(event);
  if (!row) return [];
  const endedAt = this.ms(event);
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        state,
        endedAt,
        ...(activeMs !== undefined ? { activeMs } : {}),
        ...highspeedTiming,
        ...(historyRoundCount !== undefined ? { historyRoundCount } : {}),
        ...(row.workSegments
          ? {
              workSegments: this.completeWorkSegments(row.workSegments, endedAt),
            }
          : {}),
      },
    },
  ];
}

export function recordHighspeedToolStarted(
  this: ProductProjectionContext,
  turnId: string,
  toolCallId: string,
  startedAt: number,
): void {
  const intervals = this.highspeedToolIntervalsByTurnId.get(turnId) ?? new Map();
  intervals.set(toolCallId, { startedAt });
  this.highspeedToolIntervalsByTurnId.set(turnId, intervals);
}

export function recordHighspeedToolEnded(
  this: ProductProjectionContext,
  turnId: string,
  toolCallId: string,
  endedAt: number,
  durationMs?: number,
): void {
  const intervals = this.highspeedToolIntervalsByTurnId.get(turnId) ?? new Map();
  const existing = intervals.get(toolCallId);
  const startedAt = existing?.startedAt ?? Math.max(0, endedAt - Math.max(0, durationMs ?? 0));
  intervals.set(toolCallId, {
    startedAt,
    endedAt: Math.max(
      startedAt,
      existing && durationMs !== undefined ? startedAt + durationMs : endedAt,
    ),
  });
  this.highspeedToolIntervalsByTurnId.set(turnId, intervals);
}

export function highspeedTimingForTurn(
  this: ProductProjectionContext,
  turnId: string,
  activeMs?: number,
): { modelDurationMs: number; toolDurationMs: number; otherDurationMs: number } | undefined {
  const modelDurationMs = this.highspeedModelDurationByTurnId.get(turnId);
  const intervals = this.highspeedToolIntervalsByTurnId.get(turnId);
  if (modelDurationMs === undefined && intervals === undefined) return undefined;
  const sorted = [...(intervals?.values() ?? [])]
    .filter((interval) => interval.endedAt !== undefined)
    .sort((left, right) => left.startedAt - right.startedAt);
  let toolDurationMs = 0;
  let unionEnd = -1;
  for (const interval of sorted) {
    const start = Math.max(0, interval.startedAt);
    const end = Math.max(start, interval.endedAt ?? start);
    if (start > unionEnd) toolDurationMs += end - start;
    else if (end > unionEnd) toolDurationMs += end - unionEnd;
    unionEnd = Math.max(unionEnd, end);
  }
  const model = Math.max(0, modelDurationMs ?? 0);
  const otherDurationMs = Math.max(
    0,
    (activeMs ?? model + toolDurationMs) - model - toolDurationMs,
  );
  this.highspeedModelDurationByTurnId.delete(turnId);
  this.highspeedToolIntervalsByTurnId.delete(turnId);
  return { modelDurationMs: model, toolDurationMs, otherDurationMs };
}

export function openGuidedWorkSegment(
  this: ProductProjectionContext,
  event: SessionEvent,
  triggerEntityId: string,
): ConversationDelta[] {
  const row = this.turnHeaderForEvent(event);
  if (!row || row.executionKind === "controlOnly") return [];
  const startedAt = this.ms(event);
  const existingSegments: TurnWorkSegment[] = row.workSegments ?? [
    {
      segmentId: `${row.turnId}:initial`,
      startedAt: row.startedAt,
    },
  ];
  // 旧 UI 为整个 product turn 只维护一个折叠状态，accepted guide 只能
  // 作为普通行插入，无法恢复独立工作区。分段边界必须由 CLI 记录，React 不能按邻接行猜。
  const workSegments = [
    ...this.completeWorkSegments(existingSegments, startedAt),
    {
      segmentId: triggerEntityId,
      triggerEntityId,
      startedAt,
    },
  ];
  return [{ op: "row.upserted", row: { ...row, workSegments } }];
}

export function completeWorkSegments(
  this: ProductProjectionContext,
  segments: readonly TurnWorkSegment[],
  endedAt: number,
): TurnWorkSegment[] {
  return segments.map((segment, index) =>
    index === segments.length - 1 && segment.endedAt === undefined
      ? {
          ...segment,
          endedAt,
          activeMs: Math.max(0, endedAt - segment.startedAt),
        }
      : segment,
  );
}

export function turnHeaderForEvent(
  this: ProductProjectionContext,
  event: SessionEvent,
): TurnHeaderRow | undefined {
  const rowId = this.turnHeaderRowIdByTurnId.get(this.turnIdOf(event));
  if (rowId === undefined) return undefined;
  const row = this.findRow(rowId);
  return row?.kind === "turnHeader" ? row : undefined;
}
