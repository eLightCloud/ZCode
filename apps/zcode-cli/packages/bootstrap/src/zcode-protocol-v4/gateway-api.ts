import { type BackgroundBashOutputResult } from "@zcode/shared/zcode-protocol-v4";

// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import type {
  CommandAck,
  CommandsQueryResult,
  ConversationTopicFrame,
  QueueItem,
  RoutedTopicFrame,
  SessionsIndexTopicFrame,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";

import * as implementation12 from "./gateway-attachment-conversation.js";
import * as implementation13 from "./gateway-attachment-media.js";
import * as implementation11 from "./gateway-attachment-uploads.js";
import * as implementation15 from "./gateway-command-dispatch.js";
import * as implementation16 from "./gateway-command-queries.js";
import * as implementation0 from "./gateway-connection-flow.js";
import * as implementation7 from "./gateway-conversation-resync.js";
import * as implementation6 from "./gateway-conversation-subscribe.js";
import * as implementation3 from "./gateway-detached-events.js";
import * as implementation2 from "./gateway-event-commit.js";
import * as implementation1 from "./gateway-live-events.js";
import * as implementation18 from "./gateway-publisher.js";
import * as implementation10 from "./gateway-row-queries.js";
import * as implementation17 from "./gateway-session-cleanup.js";
import * as implementation4 from "./gateway-session-index.js";
import type { V4SubscribeDispatchResult } from "./gateway-support.js";
import * as implementation8 from "./gateway-workflow-queries.js";
import * as implementation5 from "./gateway-workspace-config.js";
export interface ConversationV4GatewayApi {
  setInitialization(
    ...args: Parameters<typeof implementation18.setInitialization>
  ): ReturnType<typeof implementation18.setInitialization>;
  ensureHistoryReadyPublisher(
    ...args: Parameters<typeof implementation18.ensureHistoryReadyPublisher>
  ): ReturnType<typeof implementation18.ensureHistoryReadyPublisher>;
  setConnectionFlowState(...args: Parameters<typeof implementation0.setConnectionFlowState>): void;
  flushNow(...args: Parameters<typeof implementation0.flushNow>): ConversationTopicFrame | null;
  ingest(...args: Parameters<typeof implementation1.ingest>): void;
  waitForProjectionEventCommit(
    ...args: Parameters<typeof implementation2.waitForProjectionEventCommit>
  ): Promise<void>;
  waitForPermissionGrantCommit(
    ...args: Parameters<typeof implementation2.waitForPermissionGrantCommit>
  ): Promise<void>;
  ingestDetachedLiveSession(
    ...args: Parameters<typeof implementation3.ingestDetachedLiveSession>
  ): void;
  pruneDetachedChildPublishers(
    ...args: Parameters<typeof implementation3.pruneDetachedChildPublishers>
  ): number;
  subscribeSessionsIndex(
    ...args: Parameters<typeof implementation4.subscribeSessionsIndex>
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>>;
  subscribeSessionsIndexReserved(
    ...args: Parameters<typeof implementation4.subscribeSessionsIndexReserved>
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>>;
  subscribeWorkspaceConfig(
    ...args: Parameters<typeof implementation5.subscribeWorkspaceConfig>
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>>;
  subscribeWorkspaceConfigReserved(
    ...args: Parameters<typeof implementation5.subscribeWorkspaceConfigReserved>
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>>;
  publishWorkspaceConfig(...args: Parameters<typeof implementation5.publishWorkspaceConfig>): void;
  subscribe(
    ...args: Parameters<typeof implementation6.subscribe>
  ): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>>;
  subscribeReserved(
    ...args: Parameters<typeof implementation6.subscribeReserved>
  ): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>>;
  unsubscribe(...args: Parameters<typeof implementation6.unsubscribe>): void;
  resyncReserved(
    ...args: Parameters<typeof implementation7.resyncReserved>
  ): V4SubscribeDispatchResult<RoutedTopicFrame>;
  plans(...args: Parameters<typeof implementation8.plans>): Promise<V4ConversationPlansResult>;
  workflowRunEvents(
    ...args: Parameters<typeof implementation8.workflowRunEvents>
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  workflowRuns(
    ...args: Parameters<typeof implementation8.workflowRuns>
  ): Promise<V4ConversationWorkflowRunsResult>;
  workflowRunArtifacts(
    ...args: Parameters<typeof implementation8.workflowRunArtifacts>
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  workflowRunArtifactData(
    ...args: Parameters<typeof implementation8.workflowRunArtifactData>
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  workflowRunArtifactRead(
    ...args: Parameters<typeof implementation8.workflowRunArtifactRead>
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  workflowRunWorkspace(
    ...args: Parameters<typeof implementation8.workflowRunWorkspace>
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  workflowRunNodeResult(
    ...args: Parameters<typeof implementation8.workflowRunNodeResult>
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  rowsRange(
    ...args: Parameters<typeof implementation10.rowsRange>
  ): Promise<V4ConversationRowsRangeResult>;
  fileChanges(
    ...args: Parameters<typeof implementation10.fileChanges>
  ): Promise<V4ConversationFileChangesResult>;
  backgroundBashOutput(
    ...args: Parameters<typeof implementation10.backgroundBashOutput>
  ): Promise<BackgroundBashOutputResult>;
  fileRewindPreview(
    ...args: Parameters<typeof implementation10.fileRewindPreview>
  ): Promise<V4ConversationFileRewindPreviewResult>;
  attachmentBegin(
    ...args: Parameters<typeof implementation11.attachmentBegin>
  ): Promise<V4AttachmentBeginResult>;
  attachmentChunk(
    ...args: Parameters<typeof implementation11.attachmentChunk>
  ): Promise<V4AttachmentChunkResult>;
  attachmentCommit(
    ...args: Parameters<typeof implementation11.attachmentCommit>
  ): Promise<V4AttachmentCommitResult>;
  attachmentAbort(...args: Parameters<typeof implementation11.attachmentAbort>): Promise<void>;
  attachmentRead(
    ...args: Parameters<typeof implementation12.attachmentRead>
  ): Promise<V4AttachmentReadResult>;
  conversationAttachmentRead(
    ...args: Parameters<typeof implementation12.conversationAttachmentRead>
  ): Promise<V4ConversationAttachmentReadResult>;
  conversationAttachmentStat(
    ...args: Parameters<typeof implementation12.conversationAttachmentStat>
  ): Promise<V4ConversationAttachmentStatResult>;
  attachmentPreviewSource(
    ...args: Parameters<typeof implementation13.attachmentPreviewSource>
  ): Promise<V4AttachmentPreviewSourceResult>;
  handleCommand(...args: Parameters<typeof implementation15.handleCommand>): Promise<CommandAck>;
  queryCommands(
    ...args: Parameters<typeof implementation15.queryCommands>
  ): Promise<CommandsQueryResult>;
  getQueueItem(...args: Parameters<typeof implementation16.getQueueItem>): QueueItem | null;
  hasQueueItemKind(...args: Parameters<typeof implementation16.hasQueueItemKind>): boolean;
  hasQueuedDelivery(...args: Parameters<typeof implementation16.hasQueuedDelivery>): boolean;
  getQueueLength(...args: Parameters<typeof implementation16.getQueueLength>): number;
  hasResidencyBlockingCommands(
    ...args: Parameters<typeof implementation16.hasResidencyBlockingCommands>
  ): boolean;
  getQueueHead(...args: Parameters<typeof implementation16.getQueueHead>): {
    autoDrain: boolean;
    dispatchState: QueueItem["dispatch"]["state"];
    kind: QueueItem["kind"];
    queueItemId: string;
    text: string;
  } | null;
  getInputRoutingMode(
    ...args: Parameters<typeof implementation16.getInputRoutingMode>
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null;
  getSessionFollowupMode(
    ...args: Parameters<typeof implementation16.getSessionFollowupMode>
  ): "queue" | "guide" | null;
  getMessageIdForRow(
    ...args: Parameters<typeof implementation16.getMessageIdForRow>
  ): string | null;
  resolveRowActionTarget(
    ...args: Parameters<typeof implementation16.resolveRowActionTarget>
  ): ReturnType<typeof implementation16.resolveRowActionTarget>;
  getMessageIdsForTurnRow(
    ...args: Parameters<typeof implementation16.getMessageIdsForTurnRow>
  ): string[];
  isLatestAssistantSegmentRow(
    ...args: Parameters<typeof implementation16.isLatestAssistantSegmentRow>
  ): boolean | null;
  resolveStableForkCandidate(
    ...args: Parameters<typeof implementation16.resolveStableForkCandidate>
  ): ReturnType<typeof implementation16.resolveStableForkCandidate>;
  isLatestRetryAssistantRow(
    ...args: Parameters<typeof implementation16.isLatestRetryAssistantRow>
  ): boolean | null;
  isLatestEditableUserRow(
    ...args: Parameters<typeof implementation16.isLatestEditableUserRow>
  ): boolean | null;
  getTurnIdForRow(...args: Parameters<typeof implementation16.getTurnIdForRow>): string | null;
  getTurnRewindAnchor(
    ...args: Parameters<typeof implementation16.getTurnRewindAnchor>
  ): string | null;
  disposeSession(...args: Parameters<typeof implementation17.disposeSession>): void;
  deactivateSession(...args: Parameters<typeof implementation17.deactivateSession>): void;
  assertSessionRuntimeDeactivatable(
    ...args: Parameters<typeof implementation17.assertSessionRuntimeDeactivatable>
  ): void;
  hasConversationSubscribers(
    ...args: Parameters<typeof implementation17.hasConversationSubscribers>
  ): boolean;
  collectMemoryDiagnostics(
    ...args: Parameters<typeof implementation17.collectMemoryDiagnostics>
  ): Record<string, number>;
  dispose(...args: Parameters<typeof implementation17.dispose>): void;
  updateSharedContextImport(
    ...args: Parameters<typeof implementation18.updateSharedContextImport>
  ): void;
}
