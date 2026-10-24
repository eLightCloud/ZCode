import { type Attachment, type ToolCallPayload } from "./execution-event-values.js";
export type {
  Attachment,
  ModelMessage,
  ToolCallPayload,
  ToolResultPayload,
  ToolSchedulePayload,
  TokenUsage,
} from "./execution-event-values.js";
import {
  type ToolCallScheduledPayload,
  type ToolCallStartedPayload,
  type ToolCallProgressPayload,
  type ToolCallResultPayload,
  type ToolCallErrorPayload,
  type ToolBatchCompletePayload,
  type BackgroundTaskStartedPayload,
  type BackgroundTaskUpdatedPayload,
  type BackgroundTaskCompletedPayload,
  type DynamicWorkflowRunProgressPayload,
  type PermissionRequestedPayload,
  type PluginUiResourceUpdatedPayload,
  type PluginUiResourceListChangedPayload,
  type PluginUiAppToolCallRequestedPayload,
  type PermissionResolvedPayload,
  type PermissionDeniedPayload,
  type UserInputAutoResolutionUpdatedPayload,
  type WorkspaceHookReviewRequestedPayload,
  type WorkspaceHookReviewSettledPayload,
  type WorkspaceHookReviewSupersededPayload,
  type WorkspaceHookAdmissionUpdatedPayload,
} from "./tool-execution-payloads.js";
export type {
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
  ToolCallProgressPayload,
  ToolCallResultPayload,
  ToolCallErrorPayload,
  ToolBatchCompletePayload,
  BackgroundTaskStatus,
  BackgroundTaskPayloadBase,
  BackgroundTaskStartedPayload,
  BackgroundTaskUpdatedPayload,
  BackgroundTaskCompletedPayload,
  DynamicWorkflowRunProgressPayload,
  PermissionRequestedPayload,
  PluginUiResourceSubscriberRef,
  PluginUiResourceUpdatedPayload,
  PluginUiResourceListChangedPayload,
  PluginUiAppToolCallRequestedPayload,
  PermissionResolvedPayload,
  PermissionDeniedPayload,
  UserInputAutoResolutionState,
  UserInputAutoResolutionUpdatedPayload,
  WorkspaceHookReviewRequestedPayload,
  WorkspaceHookReviewSettledPayload,
  WorkspaceHookReviewSupersededPayload,
  WorkspaceHookAdmissionUpdatedPayload,
} from "./tool-execution-payloads.js";
import {
  type ModelRequestPayload,
  type ModelSelectedPayload,
  type TurnExecutionModelFallbackPayload,
  type ModelStreamingPayload,
  type ModelNetworkStatusPayload,
  type ModelAnomalyWarningPayload,
  type NetworkRequestStatusPayload,
  type ModelCompletePayload,
  type ModelErrorPayload,
} from "./model-execution-payloads.js";
export type {
  ModelRequestPayload,
  ModelSelectionOrigin,
  ModelSelectedPayload,
  TurnExecutionModelFallbackReason,
  TurnExecutionModelFallbackPayload,
  ModelStreamingKind,
  ModelStreamingPayload,
  ModelNetworkStatusPayload,
  ModelAnomalyWarningCategory,
  ModelAnomalyWarningSeverity,
  ModelAnomalyWarningPayload,
  NetworkRequestSource,
  NetworkRequestLifecycleStatus,
  NetworkRequestStatusPayload,
  ModelCompletePayload,
  TurnFileChangeSummary,
  TurnFileChangeSummaryItem,
  ContextUsageBreakdownSource,
  ContextUsageBreakdownItem,
  ModelErrorPayload,
} from "./model-execution-payloads.js";
import {
  type BackgroundResultOriginMeta,
  type TurnExecutionKind,
  type TurnBackgroundAttribution,
  type WorkflowLaunchMeta,
} from "./workflow-launch-metadata.js";
export type {
  WorkflowNotificationMeta,
  WorkflowBlockedMeta,
  BackgroundResultOriginMeta,
  TurnExecutionKind,
  OffPeakRunType,
  TurnBackgroundAttribution,
  WorkflowLaunchDisplay,
  WorkflowSettingsAmendMeta,
  WorkflowLaunchMeta,
} from "./workflow-launch-metadata.js";
export {
  WORKFLOW_LAUNCH_ARGS_MAX_BYTES,
  WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS,
  WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS,
  WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY,
  boundWorkflowLaunchMeta,
} from "./workflow-launch-metadata.js";
export type { PermissionDecision } from "./permission-decision.js";
import { type ErrorPayload } from "./session-error-facts.js";
export type { ErrorPayload, ErrorAttribution } from "./session-error-facts.js";
import { type SessionEvent, SessionEventType } from "./session-event-identity.js";
export { type SessionEvent, SessionEventType } from "./session-event-identity.js";

import type { RuntimeInputPresentation } from "../interfaces/runtime-input-presentation.js";
// ============================================================
// Session Events - All event types for the agent loop
// ============================================================

import type {
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MicrocompactBoundaryPayload,
} from "../compact/index.js";
import type { HookRunLifecyclePayload } from "../hooks/index.js";

import type {
  MessageVisibility,
  SessionTitleSource,
  SyntheticUserMessageSource,
} from "../interfaces/session-store.port.js";
import type {
  CollaborationMode,
  HighspeedMessageMetadata,
  TurnInputIntentMetadata,
  TurnSteerCommandKind,
  TurnSteerDeliveryMode,
  TurnSteerRejectReason,
  TurnSteerSource,
} from "../interfaces/session-execution-types.js";
import type {
  EventId,
  MessageId,
  QueryId,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
} from "../interfaces/shared.js";
import type { ModelNetworkStatusEvent, ModelUsage, ModelUsageSummary } from "../model/index.js";
import { createModelUsageSummary } from "../model/index.js";
import type { CheckpointCreatedPayload, RewindTriggeredPayload } from "../rewind/index.js";

import type { GoalCompletionVerificationOutput, SessionGoal } from "../tools/target.js";

import type {
  StreamRecoveryAnchorPayload,
  StreamRecoveryAnchorSelectedPayload,
  StreamRecoveryBlockedPayload,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
  StreamRecoveryTailDiscardedPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";

// Re-export for convenience
export type { CollaborationMode, RiskLevel } from "../interfaces/session.port.js";

// Re-export ModelToolCall as ToolCall for core usage
export type { ModelToolCall as ToolCall } from "../model/index.js";

// -----------------------------------------------
// Event Payloads
// -----------------------------------------------

export interface SessionCreatedPayload {
  planEnabled?: boolean;
  mode: CollaborationMode;
  contextWindow: number;
}

export interface SessionResumedPayload {
  directory: string;
  interruptedToolCount: number;
  messageCount: number;
  partCount: number;
  recoveredCompactTimelineCount?: number;
  recoveredSteerInputCount?: number;
  resumedTodoCount?: number;
}

export interface SessionForkedPayload {
  forkedSessionId?: SessionId;
  originalSessionId: SessionId;
  restoredFileCount?: number;
  restoredSnapshotRef?: string;
  strategy?: "fork_required";
  targetCheckpointId?: string;
  targetMessageId?: MessageId;
  /** @deprecated Use targetMessageId for message-level forks. */
  forkPoint: number;
}

export interface SessionCompactedPayload {
  compactBoundary: CompactBoundaryPayload;
  summary?: string;
  preservedEventCount?: number;
  removedEventCount?: number;
}

export type CompactLifecyclePayload = CompactTimelinePayload;

export type MicrocompactBoundaryEventPayload = MicrocompactBoundaryPayload;

/**
 * 附件渲染（additive）：用户输入附件的轻量展示元信息，随 TurnStarted 下发，
 * v4 投影据此填 userInput row 的 attachments。
 * 只承载展示所需字段，不含内容本体（内容经 resolve/persist 走 FilePart/artifact）。
 */
export interface TurnAttachmentMeta {
  fileName: string;
  mime: string;
  bytes: number;
  /** 内容引用（本地路径 / artifact URI）；data URL 等无稳定引用时缺省。 */
  ref?: string;
}

export interface TurnStartedPayloadBase {
  /** 执行入口的单调 epoch 毫秒；hooks/持久化发生在 TurnStarted 发布前，不能据发布时间反推执行开始。 */
  executionStartedAt?: number;
  turnNumber: number;
  input: string;
  /**
   * v4 文件摘要按 turn rowId 发起 query，但 workspace checkpoint 以 user messageId
   * 为恢复锚点；TurnStarted 必须携带同一个持久 id，投影才能把 userInput row
   * 反查到对应 checkpoint。
   */
  messageId?: MessageId;
  inputId?: string;
  /** 仅 admission 透传给无正文 telemetry fact；不能从 session 归属反推。 */
  /** 同一 runtime command 内覆盖 primary turn → goal verify/continue 的稳定取消身份。 */
  foregroundExecutionId?: string;
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputVisibility?: MessageVisibility;
  /**
   * 中枢直接启动已保存工作流的启动轮元数据（`inputSource === "workflow_launch"` 时在场）。
   * 活投影据它画启动卡；与消息 metadata 里的同一份对齐（冷热同形）。
   */
  workflowLaunch?: WorkflowLaunchMeta;
  /** 缺省为 agent，兼容旧事件与历史 transcript。 */
  executionKind?: TurnExecutionKind;
  /**
   * `input` 从此下标起是引擎附加文本（dwf ask 尾注 / nudge），GUI 把它折进披露；0 = 整条都是；
   * 缺席 = 无。与消息 metadata 里的同一份对齐（冷热同形）。
   */
  epilogueStart?: number;
  /** idle background wake 的结构化来源；active-loop 合流不会创建独立 TurnStarted。 */
  originMeta?: BackgroundResultOriginMeta;
  /** 仅当一个 background notification batch 的所有成员来源一致时透传；混合来源留空。 */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  targetId?: string;
  /** 本轮用户输入的附件元信息（无附件时缺省）。 */
  attachments?: TurnAttachmentMeta[];
  /** CLI admission metadata；inputId 继续作为 sourceCommandId 兼容锚点。 */
  intent?: TurnInputIntentMetadata;
}

export type TurnStartedPayload = TurnStartedPayloadBase & TurnBackgroundAttribution;

export interface TurnInputReceivedPayload {
  input: string;
  attachments?: Attachment[];
}

export interface TurnSteerQueuedPayload {
  pendingInputId: string;
  inputId?: string;
  queryId?: QueryId;
  input: string;
  inputPreview: string;
  inputSize: number;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  /** 当前排队输入消费时不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
  /** 投递语义：queue=消费时切新 product turn；guide=内联当前轮。 */
  delivery?: TurnSteerDeliveryMode;
  targetTurnId: TurnId;
  queueLength: number;
  intent?: TurnInputIntentMetadata;
}

export interface TurnSteerDeliveryChangedPayload {
  pendingInputId: string;
  targetTurnId: TurnId;
  requestedDelivery: "guide";
  admittedDelivery: "queue";
  fallbackReasonCode: string;
  /** 已改投后的完整 intent；reducer/cold replay 不从旁路状态猜 delivery。 */
  intent?: TurnInputIntentMetadata;
}

export interface TurnSteerReorderedPayload {
  orderedPendingInputIds: string[];
  targetTurnId: TurnId;
}

export interface TurnSteerDispatchChangedPayload {
  pendingInputId: string;
  reservationId?: string;
  state: "queued" | "reserved" | "promoting";
  targetTurnId: TurnId;
}

export interface QueueAutoDrainChangedPayload {
  autoDrain: boolean;
}

export interface FollowupModeChangedPayload {
  mode: "queue" | "guide";
}

export interface TurnSteerDrainedPayload {
  pendingInputIds: string[];
  queryIds?: QueryId[];
  targetTurnId: TurnId;
  injectedMessageIds: MessageId[];
  /**
   * drain 事实自带文本与持久 messageId，投影不再依赖
   * 内存 queue 状态取文本（查不到 queue item 就静默丢 user 行）。
   * delivery 决定切轮语义；缺省按 queue（每条一轮）。
   */
  drainedInputs?: Array<{
    pendingInputId: string;
    messageId: MessageId;
    text: string;
    delivery?: TurnSteerDeliveryMode;
    intent?: TurnInputIntentMetadata;
    toolDisallowlist?: readonly string[];
  }>;
}

export interface TurnSteerRejectedPayload {
  reason: TurnSteerRejectReason;
  activeTurnId?: TurnId;
  expectedTurnId?: TurnId;
  inputPreview?: string;
  inputSize?: number;
}

export interface TurnSteerDiscardedPayload {
  pendingInputIds: string[];
  targetTurnId: TurnId;
  // user_removed（v4 queue 单项删除）：用户显式从 queue 移除某项，区别于 turn 生命周期丢弃。
  // promoted：sendQueuedNow 已取得执行权，只从 queue 投影摘除；session_input 必须继续
  // 保持 admitted，直到 user message 原子 promotion（或重启后 discarded）。
  reason: "turn_cancelled" | "turn_failed" | "session_resumed" | "user_removed" | "promoted";
}

export interface SessionInputPromotedPayload {
  pendingInputId: string;
  sourceCommandId: string;
  messageId: MessageId;
}

export interface TurnCompletePayload {
  response: string;
  tokenCount: number;
  usage?: ModelUsageSummary;
  toolCallCount: number;
  /** 当前 query 已成功提交到 provider 可见持久历史的模型产物数量。 */
  historyRoundCount?: number;
  duration: number;
  inputId?: string;
  resultType: TurnResultType;
  /** 当前 turn 是否消费过来源为 subagent 的后台结果通知。 */
  backgroundSubagentResultConsumed?: boolean;
  /** 当前 turn 是否消费过来源为 workflow（dynamic-workflow run）的后台通知。 */
  workflowResultConsumed?: boolean;
  /** 内部抢占（如 sendQueuedNow）只终止当前 turn，不等价于用户手动 Stop 队列。 */
  preserveQueueAutoDrainOnCancel?: boolean;
}

export interface TurnErrorPayload {
  error: ErrorPayload;
  turnPhase: string;
  inputId?: string;
  /** 当前 turn 是否消费过来源为 subagent 的后台结果通知。 */
  backgroundSubagentResultConsumed?: boolean;
  /** 当前 turn 是否消费过来源为 workflow（dynamic-workflow run）的后台通知。 */
  workflowResultConsumed?: boolean;
}

export type TurnResultType =
  | "success"
  // "cancelled": 用户主动中断（TurnCancelled）属于正常结束，复用 TurnComplete 上报而非 TurnError。
  | "cancelled"
  | "error_max_turns"
  | "error_max_budget"
  | "error_during_execution"
  | "error_max_tool_calls";

export interface UserMessagePayload {
  content: string;
  attachments?: Attachment[];
}

export interface AssistantMessagePayload {
  content: string;
  toolCalls?: ToolCallPayload[];
}

export interface AssistantFeedbackUpdatedPayload {
  entityId: string;
  feedback: "like" | "dislike" | null;
}

export interface HighspeedMetricsUpdatedPayload {
  entityId: string;
  highspeed: HighspeedMessageMetadata;
}

export interface SystemMessagePayload {
  type: "init" | "compact_boundary" | "interrupted";
  content: string;
  compactBoundary?: CompactBoundaryPayload;
}

export interface SessionTitleUpdatedPayload {
  messageID?: MessageId;
  previousTitle: string;
  source: SessionTitleSource;
  title: string;
}

export interface SessionModeChangedPayload {
  permissionGrant?: { interactionId: string; queueItemIds: string[] };
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
  mode: CollaborationMode;
  previousMode: CollaborationMode;
  source: "tool" | "command" | "system";
  toolCallId?: ToolCallId;
}

export type TargetCompletionVerificationStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";

export interface TargetCompletionVerificationPayload {
  targetId: string;
  status: TargetCompletionVerificationStatus;
  verificationId: string;
  /** 与触发该验证的前台 runtime command 共用，供 Stop 做 stale guard。 */
  foregroundExecutionId?: string;
  /** sendQueuedNow 抢占 verifier 时只暂停 goal，不暂停 future queue。 */
  preserveQueueAutoDrainOnCancel?: boolean;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
}

export type TargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";

export type TargetChangedSource = "command" | "tool" | "runtime";

export interface TargetChangedPayload {
  action: TargetChangedAction;
  source: TargetChangedSource;
  target: SessionGoal | null;
  previousTarget?: SessionGoal | null;
}

// CollaborationMode and RiskLevel are re-exported from ports

// -----------------------------------------------
// Event Factory
// -----------------------------------------------

export function createSessionEvent<T>(
  type: SessionEventType,
  sessionId: SessionId,
  payload: T,
  options?: {
    turnId?: TurnId;
    traceId?: TraceId;
    sequenceNumber?: number;
  },
): SessionEvent {
  return {
    id: crypto.randomUUID() as EventId,
    sessionId,
    turnId: options?.turnId,
    type,
    timestamp: new Date(),
    traceId: options?.traceId ?? (crypto.randomUUID() as TraceId),
    sequenceNumber: options?.sequenceNumber ?? 0,
    payload,
  };
}

export function createModelUsageSummaryFromEvents(
  events: readonly SessionEvent[],
): ModelUsageSummary | undefined {
  const usages: ModelUsage[] = [];

  for (const event of events) {
    if (event.type === SessionEventType.ModelNetworkStatus) {
      const payload = event.payload as ModelNetworkStatusEvent;
      // 成功请求由 ModelComplete 计入；只补充失败请求的已报告用量，避免双计。
      if (payload.type === "model_request_failed" && payload.usage) usages.push(payload.usage);
    }
    if (event.type !== SessionEventType.ModelComplete) continue;
    const payload = event.payload as Partial<ModelCompletePayload>;
    if (payload.usage) {
      usages.push(payload.usage as ModelUsage);
    }
  }

  return createModelUsageSummary(usages);
}

export type SessionEventPayload =
  | SessionCreatedPayload
  | SessionResumedPayload
  | SessionForkedPayload
  | SessionCompactedPayload
  | SessionTitleUpdatedPayload
  | SessionModeChangedPayload
  | TurnStartedPayload
  | TurnInputReceivedPayload
  | TurnSteerQueuedPayload
  | TurnSteerDeliveryChangedPayload
  | TurnSteerDispatchChangedPayload
  | TurnSteerDrainedPayload
  | TurnSteerReorderedPayload
  | QueueAutoDrainChangedPayload
  | FollowupModeChangedPayload
  | TurnSteerRejectedPayload
  | TurnSteerDiscardedPayload
  | SessionInputPromotedPayload
  | TurnCompletePayload
  | TurnErrorPayload
  | UserMessagePayload
  | AssistantMessagePayload
  | SystemMessagePayload
  | ModelRequestPayload
  | ModelSelectedPayload
  | TurnExecutionModelFallbackPayload
  | ModelStreamingPayload
  | StreamingToolLedgerPayload
  | StreamRecoveryAnchorPayload
  | StreamRecoveryStartedPayload
  | StreamRecoveryAnchorSelectedPayload
  | StreamRecoveryTailDiscardedPayload
  | StreamRecoveryRetryStartedPayload
  | StreamRecoveryBlockedPayload
  | ModelNetworkStatusPayload
  | ModelAnomalyWarningPayload
  | NetworkRequestStatusPayload
  | ModelCompletePayload
  | TargetCompletionVerificationPayload
  | ModelErrorPayload
  | ToolCallScheduledPayload
  | ToolCallStartedPayload
  | ToolCallProgressPayload
  | ToolCallResultPayload
  | ToolCallErrorPayload
  | ToolBatchCompletePayload
  | BackgroundTaskStartedPayload
  | BackgroundTaskUpdatedPayload
  | BackgroundTaskCompletedPayload
  | DynamicWorkflowRunProgressPayload
  | PermissionRequestedPayload
  | PermissionResolvedPayload
  | PermissionDeniedPayload
  | PluginUiResourceUpdatedPayload
  | PluginUiResourceListChangedPayload
  | PluginUiAppToolCallRequestedPayload
  | UserInputAutoResolutionUpdatedPayload
  | WorkspaceHookReviewRequestedPayload
  | WorkspaceHookReviewSettledPayload
  | WorkspaceHookReviewSupersededPayload
  | WorkspaceHookAdmissionUpdatedPayload
  | HookRunLifecyclePayload
  | CompactLifecyclePayload
  | MicrocompactBoundaryEventPayload
  | CheckpointCreatedPayload
  | RewindTriggeredPayload
  | CompactBoundaryPayload;
