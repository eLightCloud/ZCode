// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type {
  HookRunLifecyclePayload,
  SessionEvent,
  WorkspaceHookAdmissionUpdatedPayload,
  WorkspaceHookReviewRequestedPayload,
  WorkspaceHookReviewSettledPayload,
  WorkspaceHookReviewSupersededPayload,
} from "@zcode/contracts";

import { SessionEventType } from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）

import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";

import type {
  ConversationDelta,
  HookExecutionProjection,
  HookInvocationRow,
  PendingInteraction,
} from "@zcode/shared/zcode-protocol-v4";

import { workspaceHookReviewRequestPayloadSchema } from "@zcode/shared/zcode-protocol-v4";

import type { HookInvocationRowContent } from "./product-projection-contract.js";

import {
  USER_PROMPT_HOOK_BLOCK_ERROR_TYPE,
  hookExecutionDisplayName,
} from "./product-projection-hooks.js";

import type { ProductProjectionContext } from "./projection-context.js";
export function onHookRunLifecycle(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as HookRunLifecyclePayload;
  const hookInvocationId = payload.hookInvocationId;
  const hookCount = payload.hookCount;
  if (
    !hookInvocationId ||
    !payload.hookRunId ||
    !Number.isInteger(hookCount) ||
    (hookCount ?? 0) <= 0 ||
    !Number.isInteger(payload.hookIndex) ||
    payload.hookIndex < 0
  ) {
    return [];
  }
  if (this.rewoundHookInvocationIds.has(hookInvocationId)) return [];

  const rowId = this.hookRowIdByInvocationId.get(hookInvocationId);
  const existing = rowId === undefined ? undefined : this.findRow(rowId);
  const existingRow = existing?.kind === "hookInvocation" ? existing : undefined;
  const pending = this.pendingSessionHookInvocations.get(hookInvocationId);
  const previousExecutions = existingRow?.executions ?? pending?.content.executions ?? [];
  const previousExecution = previousExecutions.find(
    (execution) => execution.hookRunId === payload.hookRunId,
  );
  const descriptor = payload.descriptor;
  if (
    !previousExecution &&
    (descriptor?.clientVisible !== true || descriptor.sourceKind === "internal")
  ) {
    return [];
  }
  const state = this.hookExecutionState(event.type);
  const startedAt =
    typeof payload.startedAt === "number" && Number.isFinite(payload.startedAt)
      ? payload.startedAt
      : (previousExecution?.startedAt ?? this.ms(event));
  const endedAt = state === "running" ? undefined : this.ms(event);
  const durationMs =
    typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
      ? Math.max(0, payload.durationMs)
      : endedAt === undefined
        ? undefined
        : Math.max(0, endedAt - startedAt);
  const outcome = this.hookExecutionOutcome(event.type, payload.outcome);
  const didExecute =
    previousExecution?.didExecute === true || event.type === SessionEventType.HookRunStarted;
  const sourceKind = previousExecution?.sourceKind ?? descriptor?.sourceKind;
  if (sourceKind === undefined || sourceKind === "internal") return [];
  const blockReason = payload.blockReason ?? previousExecution?.blockReason;
  const execution: HookExecutionProjection = {
    hookRunId: String(payload.hookRunId),
    hookIndex: payload.hookIndex,
    didExecute,
    state,
    ...(outcome ? { outcome } : {}),
    ...(blockReason ? { blockReason } : {}),
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    displayName:
      previousExecution?.displayName ??
      (descriptor
        ? hookExecutionDisplayName(descriptor, payload.hookIndex)
        : `Hook #${payload.hookIndex + 1}`),
    sourceKind,
    ...(previousExecution?.pluginName || descriptor?.pluginName
      ? { pluginName: previousExecution?.pluginName ?? descriptor?.pluginName }
      : {}),
    ...(payload.toolName || previousExecution?.toolName
      ? { toolName: payload.toolName ?? previousExecution?.toolName }
      : {}),
  };
  const byRunId = new Map(previousExecutions.map((candidate) => [candidate.hookRunId, candidate]));
  byRunId.set(execution.hookRunId, execution);
  const executions = [...byRunId.values()].toSorted(
    (left, right) => left.hookIndex - right.hookIndex,
  );
  const rowState = this.hookInvocationState(executions, hookCount as number);
  const invocationStartedAt = Math.min(...executions.map((candidate) => candidate.startedAt));
  const invocationEndedAt =
    rowState === "running"
      ? undefined
      : Math.max(...executions.map((candidate) => candidate.endedAt ?? candidate.startedAt));

  const content: HookInvocationRowContent = {
    kind: "hookInvocation",
    hookInvocationId,
    hookEventName: payload.hookEventName,
    hookCount: hookCount as number,
    state: rowState,
    startedAt: invocationStartedAt,
    ...(invocationEndedAt !== undefined
      ? {
          endedAt: invocationEndedAt,
          durationMs: Math.max(0, invocationEndedAt - invocationStartedAt),
        }
      : {}),
    lane: this.hookInvocationLane(payload.hookEventName),
    ...(payload.toolCallId ? { anchorToolCallId: String(payload.toolCallId) } : {}),
    executions,
  };

  if (existingRow) {
    const blockErrorDelta = this.hookBlockErrorDelta(event, payload, didExecute, blockReason);
    return [
      {
        op: "row.upserted",
        row: {
          ...existingRow,
          ...content,
        },
      },
      ...(blockErrorDelta ? [blockErrorDelta] : []),
    ];
  }

  if (
    pending ||
    !event.turnId ||
    // 维护 turn 排除只属于 SessionStart——首条输入即 /compact 时
    // SessionStart Hook 携带 compact turnId 到达，不能直挂，先入 pending 等
    // 真实 turn。model-only ≠ 维护 turn：background_task / subagent_message /
    // goal continuation 轮同样是 model-only，但它们是会真实跑工具的 agent 轮，
    // 其 PreToolUse/PostToolUse/Stop 必须按 event.turnId 直挂原轮（与 cold
    // merge 归属对齐），否则会被 pending 吞掉、错误堆到下一个用户轮。
    (payload.hookEventName === "SessionStart" &&
      (this.currentTurnId === null || this.currentTurnStartedModelOnly))
  ) {
    // startup SessionStart 虽可能已经携带 runtime turnId，但此时 TurnStarted 尚未建立
    // runtimeTurnId -> productTurnId 映射；提前 append 会把它拆成独立 footer。
    this.pendingSessionHookInvocations.set(hookInvocationId, {
      firstEvent: pending?.firstEvent ?? event,
      content,
    });
    return [];
  }

  const turnId = this.turnIdOf(event);
  const rowBase = this.rowBase(event, turnId, hookInvocationId);
  const row: HookInvocationRow = {
    ...rowBase,
    ...content,
  };
  this.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
  const blockErrorDelta = this.hookBlockErrorDelta(event, payload, didExecute, blockReason);
  return [{ op: "row.appended", row }, ...(blockErrorDelta ? [blockErrorDelta] : [])];
}

/**
 * UserPromptSubmit 的 executed block 是当前输入的可见错误，但不是 task 失败。
 * 将它投影到 transient lastError，让 ChatErrorBanner 直接展示原因；下一轮 TurnStarted
 * 会按既有生命周期清理它。admission-only block 和工具边界 block 仍只保留在 Hook 摘要。
 */

export function hookBlockErrorDelta(
  this: ProductProjectionContext,
  event: SessionEvent,
  payload: HookRunLifecyclePayload,
  didExecute: boolean,
  blockReason: string | undefined,
): ConversationDelta | null {
  if (
    event.type !== SessionEventType.HookRunBlocked ||
    payload.hookEventName !== "UserPromptSubmit" ||
    !didExecute ||
    !blockReason
  ) {
    return null;
  }
  const diagnosticMessage = [payload.stderrPreview, payload.errorMessage, payload.stdoutPreview]
    .map((value) => value?.trim())
    .find((value) => value && value !== blockReason);
  const displayReason = diagnosticMessage ?? blockReason;
  const message =
    displayReason === USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
      ? USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
      : `${USER_PROMPT_HOOK_BLOCK_ERROR_TYPE}: ${displayReason}`;
  const detail = [
    `Hook block reason: ${blockReason}`,
    ...(diagnosticMessage ? [`Hook error: ${diagnosticMessage}`] : []),
  ].join("\n");
  return {
    op: "state.updated",
    patch: this.controlPatch({
      lastError: {
        code: "fault.runtime.hookBlocked",
        message,
        recoverable: false,
        at: this.ms(event),
        source: "runtime",
        traceId: String(event.traceId),
        ...(detail ? { detail } : {}),
        attribution: {
          source: "runtime",
          reason: "hook_blocked",
        },
      },
    }),
  };
}

export function flushPendingSessionHookInvocations(
  this: ProductProjectionContext,
  turnId: string,
): ConversationDelta[] {
  if (this.pendingSessionHookInvocations.size === 0) return [];
  const deltas: ConversationDelta[] = [];
  for (const [hookInvocationId, pending] of this.pendingSessionHookInvocations) {
    const row: HookInvocationRow = {
      ...this.rowBase(pending.firstEvent, turnId, hookInvocationId),
      ...pending.content,
    };
    this.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
    deltas.push({ op: "row.appended", row });
  }
  this.pendingSessionHookInvocations.clear();
  return deltas;
}

export function hookExecutionState(
  this: ProductProjectionContext,
  eventType: SessionEvent["type"],
): HookExecutionProjection["state"] {
  if (eventType === SessionEventType.HookRunFailed) return "failed";
  if (
    eventType === SessionEventType.HookRunCompleted ||
    eventType === SessionEventType.HookRunBlocked
  ) {
    return "completed";
  }
  return "running";
}

export function hookExecutionOutcome(
  this: ProductProjectionContext,
  eventType: SessionEvent["type"],
  outcome: HookRunLifecyclePayload["outcome"],
): HookExecutionProjection["outcome"] {
  if (outcome) return outcome;
  if (eventType === SessionEventType.HookRunCompleted) return "success";
  if (eventType === SessionEventType.HookRunBlocked) return "blocked";
  if (eventType === SessionEventType.HookRunFailed) return "failed";
  return undefined;
}

export function hookInvocationState(
  this: ProductProjectionContext,
  executions: readonly HookExecutionProjection[],
  hookCount: number,
): HookInvocationRow["state"] {
  if (
    executions.length < hookCount ||
    executions.some((execution) => execution.state === "running")
  ) {
    return "running";
  }
  return executions.some((execution) => execution.state === "failed") ? "failed" : "completed";
}

export function hookInvocationLane(
  this: ProductProjectionContext,
  eventName: HookRunLifecyclePayload["hookEventName"],
): HookInvocationRow["lane"] {
  if (eventName === "PreToolUse" || eventName === "PermissionRequest") return "toolBefore";
  if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") return "toolAfter";
  return "assistantWork";
}

export function onWorkspaceHookReviewRequested(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewRequestedPayload;
  const request = workspaceHookReviewRequestPayloadSchema.parse(payload.request);
  const current = this.snapshot.pendingInteractions.find(
    (item) => item.payload.kind === "workspaceHookReview",
  );
  if (current?.payload.kind === "workspaceHookReview") {
    const verdict = verdictWorkspaceHookReviewRequest(current.payload, request);
    // 跨 flow 只能在 onSessionResumed 已清空旧 review 后接管（epoch 应用策略在
    // onSessionResumed）；其余 stale/replay/conflict 均不得覆盖或延长当前 authority。
    if (verdict !== "same_flow_advance") {
      return [];
    }
  }
  const interaction: PendingInteraction = {
    interactionId: request.interactionId,
    kind: "workspaceHookReview",
    anchorRowId: null,
    createdAt: request.createdAt,
    payload: request,
  };
  // 同 flow 的更高 generation 是唯一合法替换；Runtime 重启的跨 flow 接管必须先经过
  // SessionResumed 清旧 authority。这里仍原子替换，避免历史异常状态残留多个 review。
  const pendingInteractions = this.snapshot.pendingInteractions.filter(
    (item) => item.payload.kind !== "workspaceHookReview",
  );
  pendingInteractions.push(interaction);
  return [{ op: "state.updated", patch: { pendingInteractions } }];
}

export function onWorkspaceHookReviewSettled(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewSettledPayload;
  return this.removeWorkspaceHookReview(payload.interactionId);
}

export function onWorkspaceHookReviewSuperseded(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewSupersededPayload;
  return this.removeWorkspaceHookReview(payload.interactionId);
}

export function removeWorkspaceHookReview(
  this: ProductProjectionContext,
  interactionId: string,
): ConversationDelta[] {
  const pendingInteractions = this.snapshot.pendingInteractions.filter(
    (item) =>
      !(item.payload.kind === "workspaceHookReview" && item.interactionId === interactionId),
  );
  return pendingInteractions.length === this.snapshot.pendingInteractions.length
    ? []
    : [{ op: "state.updated", patch: { pendingInteractions } }];
}

/**
 * 软门禁:处理 WorkspaceHookAdmissionUpdated 事件。
 *
 * pendingCount > 0 → 写入 snapshot.workspaceHookAdmission(提示条出现);
 * pendingCount === 0 → 置 null(提示条消失)。
 */

export function onWorkspaceHookAdmissionUpdated(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookAdmissionUpdatedPayload;
  const workspaceHookAdmission =
    payload.pendingCount === 0
      ? null
      : {
          pendingCount: payload.pendingCount,
          bundleDigest: payload.bundleDigest,
          ...(payload.workspaceIdentity ? { workspaceIdentity: payload.workspaceIdentity } : {}),
        };
  return [{ op: "state.updated", patch: { workspaceHookAdmission } }];
}
