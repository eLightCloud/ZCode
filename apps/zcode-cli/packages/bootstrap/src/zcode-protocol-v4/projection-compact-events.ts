// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type { CompactLifecyclePayload, SessionEvent, SessionForkedPayload } from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）

import type {
  ConversationDelta,
  TimelineMarkerPayload,
  TimelineMarkerRow,
} from "@zcode/shared/zcode-protocol-v4";

import { mapCompactMarkerOrigin, mapCompactMarkerStatus } from "./projection-rows.js";

import type { ProductProjectionContext } from "./projection-context.js";
// ── compact marker（compact 命令效果）──
// 同一 operationId 全生命周期占同一 marker row：running → success/failed/noop/cancelled。
// 归属：marker 落在事件到达时的行尾，客户端零归属逻辑。

export function onCompactLifecycle(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as CompactLifecyclePayload & {
    anchorMessageId?: string;
    tailStartMessageId?: string;
  };
  const existingRowId = this.compactMarkerRowIdByOperationId.get(payload.operationId);
  const existingRow = existingRowId !== undefined ? this.findRow(existingRowId) : undefined;
  const prev =
    existingRow?.kind === "timelineMarker" && existingRow.marker.type === "compact"
      ? existingRow.marker
      : undefined;

  const status = mapCompactMarkerStatus(payload.status);
  if (status === "success") {
    const coverageMessageId = payload.tailStartMessageId ?? payload.anchorMessageId;
    const coverageRowId = coverageMessageId ? this.rowIdForMessageId(coverageMessageId) : null;
    if (coverageRowId !== null) {
      this.stableCompactCoverageBoundaryRowId = Math.max(
        this.stableCompactCoverageBoundaryRowId ?? 0,
        coverageRowId,
      );
      for (const [rowId, entityId] of this.entityIdByRowId) {
        if (rowId > this.stableCompactCoverageBoundaryRowId) continue;
        const target = this.editTargetByEntityId.get(entityId);
        if (target && !target.coveredByStableCompact) {
          this.editTargetByEntityId.set(entityId, {
            ...target,
            coveredByStableCompact: true,
          });
        }
      }
    }
  }
  const tokensAfter =
    payload.truePostCompactTokenCount ?? payload.postCompactTokenCount ?? prev?.tokensAfter;
  const marker: TimelineMarkerPayload = {
    type: "compact",
    origin: prev?.origin ?? mapCompactMarkerOrigin(payload.trigger),
    status,
    // 终态事件才带 token 计数；upsert 时保留已知值（retry 不清零）。
    ...(payload.preCompactTokenCount !== undefined || prev?.tokensBefore !== undefined
      ? { tokensBefore: payload.preCompactTokenCount ?? prev?.tokensBefore }
      : {}),
    ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    // summary 全文按 ref 拉（同 toolOutput/get）；以 summaryMessageId 占位。
    ...(payload.summaryMessageId !== undefined || prev?.summaryRef
      ? {
          summaryRef:
            payload.summaryMessageId !== undefined
              ? String(payload.summaryMessageId)
              : prev?.summaryRef,
        }
      : {}),
  };

  const deltas: ConversationDelta[] = [];
  if (existingRow?.kind === "timelineMarker") {
    deltas.push({
      op: "row.upserted",
      row: {
        ...existingRow,
        marker,
        ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
      },
    });
  } else {
    const row: TimelineMarkerRow = {
      ...this.rowBase(event, this.turnIdOf(event), String(payload.operationId)),
      kind: "timelineMarker",
      lane: "assistantWork",
      marker,
      ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
    };
    this.compactMarkerRowIdByOperationId.set(payload.operationId, row.rowId);
    deltas.push({ op: "row.appended", row });
  }

  // compacting 进出 activeWorks（guard 同源派生：compactOperationLock /
  // compactingAcceptsFutureInput 由此驱动，与 formal-proof evaluateCompacting 对齐）。
  const otherWorks = this.snapshot.control.activeWorks.filter((work) => work.kind !== "compact");
  if (status === "running") {
    deltas.push({
      op: "state.updated",
      patch: this.controlPatch({
        activeWorks: [...otherWorks, { kind: "compact", startedAt: this.ms(event) }],
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: otherWorks.length > 0 ? "mixed" : "compact",
      }),
    });
  } else {
    deltas.push({
      op: "state.updated",
      patch: this.controlPatch({
        activeWorks: otherWorks,
        ...(otherWorks.length === 0
          ? {
              canStop: false,
              stopState: "idle" as const,
              stopTargetKind: "unknown" as const,
            }
          : {}),
      }),
    });
  }

  // compact 成功 → context 水位立即回落（usage.contextWindow 更新）。
  if (status === "success" && tokensAfter !== undefined) {
    this.contextWindowState.usedTokens = tokensAfter;
    const maxTokens =
      this.snapshot.usage.contextWindow?.maxTokens ?? this.contextWindowState.maxTokens;
    deltas.push({
      op: "state.updated",
      patch: {
        usage: {
          ...this.snapshot.usage,
          contextWindow:
            maxTokens === null
              ? null
              : {
                  usedTokens: tokensAfter,
                  maxTokens,
                  autoCompactThresholdTokens:
                    this.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                },
        },
      },
    });
  }
  return deltas;
}

/**
 * rewind/edit/retry 的 live 投影截断（editUserQuery/retryTurn 的
 * `row.removed(target 起)`）。RewindTriggered 带 targetMessageId → 反查 rowId →
 * 从该行所属 turn 的首行（turnHeader）起整段移除，让 live 订阅者即时看到截断，
 * 后续 editRerun 新 turn 走既有事件路径追加。冷订阅/刷新的 truncated transcript
 * 由 transcript 合成 hydration 兜底重建。
 * messageId 反查不到（user 行暂无 messageId、或迟到）时返回空，不误删。
 */

export function onRewindTriggered(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    targetMessageId?: string;
    scope?: string;
    branchCutAfterMessageId?: string;
    branchGeneration?: number;
    createdMessageId?: string;
    reason?: string;
  };
  if (payload.scope === "workspace" && payload.reason === "file_summary_rewind") {
    const targetMessageId = payload.targetMessageId;
    if (!targetMessageId) return [];
    const targetRowId = this.rowIdForMessageId(targetMessageId);
    if (targetRowId === null) return [];
    const targetRow = this.findRow(targetRowId);
    if (!targetRow) return [];
    const headerRowId = this.turnHeaderRowIdByTurnId.get(targetRow.turnId);
    const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
    if (headerRow?.kind !== "turnHeader" || !headerRow.fileChanges) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...headerRow,
          fileChanges: {
            ...headerRow.fileChanges,
            state: "reverted",
          },
        },
      },
    ];
  }
  // 新语义只消费带 branchGeneration/cut 的已提交 conversation rewind；createdMessageId
  // 仅兼容旧 transcript。失败/冲突不发事件，因此不会制造 UI 假截断。
  const applied =
    (payload.branchGeneration !== undefined && payload.branchCutAfterMessageId !== undefined) ||
    payload.createdMessageId !== undefined;
  if ((payload.scope !== "conversation" && payload.scope !== "both") || !applied) return [];
  const targetMessageId = payload.targetMessageId;
  if (!targetMessageId) return [];
  const targetRowId = this.rowIdForMessageId(targetMessageId);
  if (targetRowId === null) return [];
  const targetRow = this.findRow(targetRowId);
  if (!targetRow) return [];
  // 从该行所属 turn 的首行起移除（整段 turn 被 rewind/edit/retry 替换）。
  const turnHeaderRowId = this.turnHeaderRowIdByTurnId.get(targetRow.turnId) ?? targetRowId;
  const fromRowId = Math.min(turnHeaderRowId, targetRowId);
  // 清理被移除行的 messageId/tool 索引，避免悬挂映射。
  for (const [rowId] of this.messageIdByRowId) {
    if (rowId >= fromRowId) this.messageIdByRowId.delete(rowId);
  }
  for (const [messageId, rowId] of this.outputContinuationRowIdByMessageId) {
    if (rowId >= fromRowId) this.outputContinuationRowIdByMessageId.delete(messageId);
  }
  for (const [rowId, entityId] of this.entityIdByRowId) {
    if (rowId >= fromRowId) {
      this.entityIdByRowId.delete(rowId);
      this.editTargetByEntityId.delete(entityId);
    }
  }
  for (const [hookInvocationId, rowId] of this.hookRowIdByInvocationId) {
    if (rowId >= fromRowId) {
      this.rewoundHookInvocationIds.add(hookInvocationId);
      this.hookRowIdByInvocationId.delete(hookInvocationId);
    }
  }
  return [{ op: "row.removed", fromRowId }];
}

// ── fork marker（forkAssistant 命令效果）──

export function onSessionForked(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as SessionForkedPayload;
  const isParent = String(payload.originalSessionId) === this.snapshot.sessionId;
  if (isParent) {
    // 父时间线不显示 forkCreated——fork 关系只在 sessions
    // 树/列表体现。旧实现以 nextRowId-1 近似锚点产 row，且 UI 渲染为 null
    // （隐形行污染 turn 分组）；child 首部 forkNotice 保留不变。
    return [];
  }
  // child 首部 forkNotice（forkTimelineIsBoundary）：事件 payload 不携带
  // parent 侧 rowId，先以 0 占位；transcript 锚点 → rowId 映射随传输外壳补齐。
  const row: TimelineMarkerRow = {
    ...this.rowBase(
      event,
      this.turnIdOf(event),
      `fork:${String(payload.originalSessionId)}:${String(payload.targetMessageId ?? "unknown")}`,
    ),
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: {
      type: "forkNotice",
      parentSessionId: String(payload.originalSessionId),
      parentRowId: 0,
    },
  };
  return [{ op: "row.appended", row }];
}
