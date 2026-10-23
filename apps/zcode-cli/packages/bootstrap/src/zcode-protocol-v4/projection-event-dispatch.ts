// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type {
  PluginUiAppToolCallRequestedPayload,
  PluginUiResourceListChangedPayload,
  PluginUiResourceUpdatedPayload,
  SessionEvent,
} from "@zcode/contracts";

import { SessionEventType } from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）
import { isZCodeModelRetryRecoveryProgressPayload } from "@zcode/shared";

import type { ConversationDelta, HookExecutionProjection } from "@zcode/shared/zcode-protocol-v4";

import { type CanonicalConversationFact } from "./event-normalizer.js";

import type { ProductProjectionContext } from "./projection-context.js";
export function reduce(
  this: ProductProjectionContext,
  fact: CanonicalConversationFact,
): ConversationDelta[] {
  const event = fact.event;
  switch (event.type) {
    case SessionEventType.SessionCreated:
      return this.onSessionCreated(event);
    case SessionEventType.SessionResumed:
      return this.onSessionResumed(event);
    case SessionEventType.SessionTitleUpdated:
      return this.onSessionTitleUpdated(event);
    case SessionEventType.TurnStarted:
      if (fact.semanticKind !== "userIntent") return [];
      return [
        ...this.onTurnStarted(fact),
        // model-only 维护 turn（manual /compact、goal continuation）没有资格
        // 承载 SessionStart 摘要；pending 保持到下一条 user-visible 真实 turn。
        ...(this.currentTurnStartedModelOnly
          ? []
          : this.flushPendingSessionHookInvocations(fact.productTurnId)),
      ];
    case SessionEventType.ModelStreaming: {
      if (fact.semanticKind !== "assistantSegment") return [];
      const shouldClearApiRetry =
        this.acceptsActiveModelEvent(event) &&
        isZCodeModelRetryRecoveryProgressPayload(
          event.payload as unknown as Record<string, unknown>,
        );
      const streamingDeltas = this.onModelStreaming(fact);
      return shouldClearApiRetry
        ? [...streamingDeltas, ...this.setApiRetry(null)]
        : streamingDeltas;
    }
    case SessionEventType.ModelNetworkStatus:
      return this.onModelNetworkStatus(event);
    case SessionEventType.StreamRecoveryStarted:
      return this.onStreamRecoveryStarted(event);
    case SessionEventType.StreamRecoveryTailDiscarded:
      return this.onStreamRecoveryTailDiscarded(event);
    case SessionEventType.StreamRecoveryRetryStarted:
      return this.onStreamRecoveryRetryStarted(event);
    case SessionEventType.ModelSelected:
      return this.onModelSelected(event);
    case SessionEventType.ModelComplete:
      return this.onModelComplete(event);
    case SessionEventType.ToolCallScheduled:
      return this.onToolCallScheduled(event);
    case SessionEventType.ToolCallStarted:
      return this.onToolCallActivity(event);
    case SessionEventType.ToolCallProgress:
      return this.onToolCallProgress(event);
    case SessionEventType.ToolCallResult:
      return this.onToolCallResult(event);
    case SessionEventType.ToolCallError:
      return this.onToolCallError(event);
    case SessionEventType.PermissionRequested:
      return this.onPermissionRequested(event);
    case SessionEventType.PermissionResolved:
      return this.onPermissionResolved(event);
    case SessionEventType.PermissionDenied:
      return this.onPermissionDenied(event);
    case SessionEventType.PluginUiResourceUpdated: {
      // live-only，不改快照；renderer 按 subscribers 派发给沙箱实例。
      const payload = event.payload as PluginUiResourceUpdatedPayload;
      return [
        {
          op: "pluginUi.resourceUpdated",
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          uri: payload.uri,
          subscribers: payload.subscribers,
        },
      ];
    }
    case SessionEventType.PluginUiResourceListChanged: {
      const payload = event.payload as PluginUiResourceListChangedPayload;
      return [
        {
          op: "pluginUi.resourceListChanged",
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          subscribers: payload.subscribers,
        },
      ];
    }
    case SessionEventType.PluginUiInstanceClosed: {
      const payload = event.payload as PluginUiResourceListChangedPayload;
      return [{ op: "pluginUi.instanceClosed", ...payload }];
    }
    case SessionEventType.PluginUiAppToolCallRequested: {
      // App-Provided Tools 信箱：live-only，投递给 subscribers 里唯一的实例。
      const payload = event.payload as PluginUiAppToolCallRequestedPayload;
      return [
        {
          op: "pluginUi.appToolCall",
          activity: payload.activity,
          ...(payload.cancelled ? { cancelled: true } : {}),
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          subscribers: payload.subscribers,
          callId: payload.callId,
          toolName: payload.toolName,
          arguments: payload.arguments,
        },
      ];
    }
    case SessionEventType.UserInputAutoResolutionUpdated:
      return this.onUserInputAutoResolutionUpdated(event);
    case SessionEventType.WorkspaceHookReviewRequested:
      return this.onWorkspaceHookReviewRequested(event);
    case SessionEventType.WorkspaceHookReviewSettled:
      return this.onWorkspaceHookReviewSettled(event);
    case SessionEventType.WorkspaceHookReviewSuperseded:
      return this.onWorkspaceHookReviewSuperseded(event);
    case SessionEventType.WorkspaceHookAdmissionUpdated:
      return this.onWorkspaceHookAdmissionUpdated(event);
    case SessionEventType.HookRunStarted:
    case SessionEventType.HookRunProgress:
    case SessionEventType.HookRunCompleted:
    case SessionEventType.HookRunFailed:
    case SessionEventType.HookRunBlocked:
      return this.onHookRunLifecycle(event);
    case SessionEventType.TurnSteerQueued:
      return this.onTurnSteerQueued(event);
    case SessionEventType.TurnSteerDeliveryChanged:
      return this.onTurnSteerDeliveryChanged(event);
    case SessionEventType.TurnSteerDispatchChanged:
      return this.onTurnSteerDispatchChanged(event);
    case SessionEventType.TurnSteerDrained:
      return this.onTurnSteerDrained(event);
    case SessionEventType.TurnSteerDiscarded:
      return this.onTurnSteerDiscarded(event);
    case SessionEventType.SessionInputPromoted:
      return this.onSessionInputPromoted(event);
    case SessionEventType.TurnSteerReordered:
      return this.onTurnSteerReordered(event);
    case SessionEventType.QueueAutoDrainChanged:
      return this.onQueueAutoDrainChanged(event);
    case SessionEventType.FollowupModeChanged:
      return this.onFollowupModeChanged(event);
    case SessionEventType.SessionModeChanged:
      return this.onSessionModeChanged(event);
    case SessionEventType.TurnComplete:
      return this.onTurnComplete(event);
    case SessionEventType.TurnError:
      return this.onTurnError(event);
    case SessionEventType.CompactStarted:
    case SessionEventType.CompactCompleted:
    case SessionEventType.CompactFailed:
      return this.onCompactLifecycle(event);
    case SessionEventType.TargetChanged:
      return this.onTargetChanged(event);
    case SessionEventType.TargetCompletionVerification:
      return this.onTargetVerification(event);
    case SessionEventType.SessionForked:
      return this.onSessionForked(event);
    case SessionEventType.RewindTriggered:
      return this.onRewindTriggered(event);
    case SessionEventType.BackgroundTaskStarted:
    case SessionEventType.BackgroundTaskUpdated:
    case SessionEventType.BackgroundTaskCompleted:
      return this.onBackgroundTaskLifecycle(event);
    case SessionEventType.DynamicWorkflowRunProgress:
      return this.onDynamicWorkflowRunProgress(event);
    case SessionEventType.SubagentSpawned:
      return this.onSubagentSpawned(event);
    case SessionEventType.SubagentMessage:
      return this.onSubagentMessage(event);
    case SessionEventType.SubagentStopped:
      return this.onSubagentStopped(event);
    default:
      return [];
  }
}

/** A persisted started-only Hook cannot still be running after a real runtime resume. */

export function onSessionResumed(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const endedAt = this.ms(event);
  const deltas: ConversationDelta[] = [];
  // Runtime epoch 切换前尚未归位的 session Hook 不得附着到新 epoch 的下一轮；
  // 新 Runtime 会重新产生自己的 resume SessionStart lifecycle。
  this.pendingSessionHookInvocations.clear();
  for (const row of this.snapshot.rows.window) {
    if (row.kind !== "hookInvocation" || row.state !== "running") continue;
    const executions = row.executions.map(
      (execution): HookExecutionProjection =>
        execution.state === "running"
          ? {
              ...execution,
              state: "failed",
              outcome: "cancelled",
              endedAt,
              durationMs: Math.max(0, endedAt - execution.startedAt),
            }
          : execution,
    );
    deltas.push({
      op: "row.upserted",
      row: {
        ...row,
        state: "failed",
        executions,
        endedAt,
        durationMs: Math.max(0, endedAt - row.startedAt),
      },
    });
  }
  const pendingInteractions = this.snapshot.pendingInteractions.filter(
    (interaction) => interaction.payload.kind !== "workspaceHookReview",
  );
  if (pendingInteractions.length !== this.snapshot.pendingInteractions.length) {
    // reviewFlowId/generation 只在单个 Runtime controller 内单调。
    // Runtime 重启后旧 Requested 会先被 replay，而新 flow 又从 generation=1 开始；
    // SessionResumed 是明确的新 Runtime epoch 边界，必须先淘汰旧 Runtime 无法再解析的审核。
    deltas.push({ op: "state.updated", patch: { pendingInteractions } });
  }
  // 软门禁:resume 后 activate 会重新上报 admission 状态。
  // epoch 清理时置 null,避免旧 Runtime 的提示条残留到新 Runtime 接管前。
  if (this.snapshot.workspaceHookAdmission !== null) {
    deltas.push({ op: "state.updated", patch: { workspaceHookAdmission: null } });
  }
  return deltas;
}
