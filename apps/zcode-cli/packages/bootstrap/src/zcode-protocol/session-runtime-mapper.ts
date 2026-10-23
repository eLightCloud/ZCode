import {
  type ZCodeActiveToolCall,
  type ZCodeDeliveryKind,
  type ZCodePendingPermission,
  type ZCodeSessionProjection,
  type ZCodeSessionRuntimeState,
} from "@zcode/shared";

import {
  type ActiveToolCall,
  type BackgroundTaskInfo,
  type MessageWithParts,
  type PendingPermission,
  type SessionEvent,
  type SessionProjection,
} from "@zcode/contracts";

import type { ZCodeApp } from "../app/types.js";

import {
  buildProtocolPermissionOptions,
  toLegacyPermissionOptionsPolicy,
} from "./permission-options.js";

import { mapSessionGoal } from "./session-goal-stats.js";

import { resolveSessionContextUsage } from "./session-context-usage.js";

import { mapGoalVerificationTimeline, mapGoalVerifications } from "./session-goal-verifications.js";

import { asRecord, stringValue } from "./session-mapper-values.js";

export function mapSessionProjection(projection: SessionProjection): ZCodeSessionProjection {
  return {
    activeToolCalls: projection.activeToolCalls.map(mapActiveToolCall),
    backgroundJobs: projection.backgroundTasks.map(mapBackgroundTask),
    contextUsed: projection.contextUsed,
    contextWindow: projection.contextWindow,
    currentTurnId: projection.currentTurnId ? String(projection.currentTurnId) : undefined,
    lastError: projection.lastError,
    mode: projection.mode,
    pendingPermissions: projection.pendingPermissions.map(mapPendingPermission),
    sessionId: String(projection.id),
    status: projection.status,
    target: mapSessionGoal(projection.target),
    totalTokenCount: projection.totalTokenCount,
    turnCount: projection.turnCount,
  };
}

export function mapRuntimeState(input: {
  activeTurn?: ReturnType<ZCodeApp["runtime"]["getActiveTurnInfo"]>;
  deliveryKind?: ZCodeDeliveryKind;
  eventSeq: number;
  messages: MessageWithParts[];
  persistedContextUsageBreakdownEvents?: readonly SessionEvent[];
  projection: SessionProjection;
  stateRevision: number;
}): ZCodeSessionRuntimeState {
  // projection.currentTurnId 是投影最后处理过的 turn，不代表当前仍在运行。
  // session 恢复/subscribe 快照如果把它回填成 runtime.activeTurnId，会让已 idle/complete 的任务误显示为 thinking。
  const activeTurnId = input.activeTurn?.turnId;
  const contextUsage = resolveSessionContextUsage({
    messages: input.messages,
    persistedContextUsageBreakdownEvents: input.persistedContextUsageBreakdownEvents,
    projection: input.projection,
  });
  // 共享 runtime schema 已用 activeTurnId/activeTurnKind 表达运行中 turn；
  // mainActive 是旧 UI 派生字段，继续从 CLI 快照写出会让 bootstrap 独立 build 失败。
  return {
    activeTurnId: activeTurnId ? String(activeTurnId) : undefined,
    activeTurnKind: input.activeTurn?.kind,
    deliveryKind: input.deliveryKind,
    eventSeq: input.eventSeq,
    pendingRequestIds: input.projection.pendingPermissions.map(
      (permission) => permission.requestId ?? permission.toolCallId,
    ),
    ...(contextUsage ? { contextUsage } : {}),
    goalVerifications: mapGoalVerifications(input.projection.targetCompletionVerifications),
    goalVerificationTimeline: mapGoalVerificationTimeline(
      input.projection.targetCompletionVerificationTimeline,
    ),
    stateRevision: input.stateRevision,
  };
}

export function mapPendingPermission(permission: PendingPermission): ZCodePendingPermission {
  // display / optionsPolicy 刻意不进 legacy v3 输出。
  // 根因不是"扩 schema 只能单向兼容"，而是 strict schema 随 packages/shared 打进每个桌面端
  // 的产物：今天把 zcodePendingPermissionSchema（shared/src/zcode-protocol/index.ts:1139）和
  // zcodePermissionRequestedEventPayloadSchema（同文件:1536）改成可选，也保护不了已经装出去
  // 的旧桌面。新 CLI 一旦在 v3 路径上带这两个字段，旧桌面会整份快照解析失败、并用 safeParse
  // 静默丢弃整个 permission.requested 事件——确认窗本身就没了，这违反"只允许预览降级、
  // 不允许 gate 降级"。剥离在源头是唯一对版本偏斜安全的做法；legacy 也没有画因果图的界面。
  // optionsPolicy 的效果仍然生效：它作为 buildProtocolPermissionOptions 的输入裁掉
  // allow_always，只有裁剪后的 options 列表过协议。会话免确认同样降级为裁剪：
  // 旧桌面回传的是 response 原文，认不出会话语义（见 toLegacyPermissionOptionsPolicy）。
  return {
    input: permission.input,
    ...(permission.origin ? { origin: permission.origin } : {}),
    options: buildProtocolPermissionOptions({
      ...permission,
      optionsPolicy: toLegacyPermissionOptionsPolicy(permission.optionsPolicy),
    }),
    reason: permission.reason ?? "",
    requestId: permission.requestId ?? permission.toolCallId,
    requestedAt: permission.requestedAt.getTime(),
    riskLevel: permission.riskLevel,
    toolCallId: permission.toolCallId,
    toolName: permission.toolName,
  };
}

export function mapPermissionRequestedPayload(payload: unknown): Record<string, unknown> {
  // 同 mapPendingPermission：这个 payload 是整体 spread 出去的，新字段必须在这里显式解构
  // 剔除，否则会直接漏进 strict 的 zcodePermissionRequestedEventPayloadSchema。
  const { display: _display, optionsPolicy, ...record } = asRecord(payload);
  const toolName = stringValue(record.toolName) ?? "unknown";
  return {
    ...record,
    options: buildProtocolPermissionOptions({
      approvalMode: record.approvalMode === "user-once" ? "user-once" : undefined,
      input: record.input,
      suggestedPermissionUpdates: Array.isArray(record.suggestedPermissionUpdates)
        ? (record.suggestedPermissionUpdates as PendingPermission["suggestedPermissionUpdates"])
        : undefined,
      optionsPolicy: toLegacyPermissionOptionsPolicy(optionsPolicy),
      toolName,
    }),
  };
}

export function mapActiveToolCall(toolCall: ActiveToolCall): ZCodeActiveToolCall {
  return {
    startedAt: toolCall.startedAt?.getTime(),
    status: toolCall.status,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
  };
}

export function mapBackgroundTask(task: BackgroundTaskInfo): Record<string, unknown> {
  return { ...task };
}
