import type { LocalTtftRecorder } from "./local-ttft.js";
import type { ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";
import type { RoutedTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type { SubscribeAck } from "@zcode/shared/zcode-protocol-v4";
import type { AttachmentUploadRegistry } from "./attachment-upload-registry.js";
import type { ColdSessionResumeCoordinator } from "./cold-session-resume.js";
import type { CommandInbox } from "./command-inbox.js";
import type { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { SessionsIndexFanoutThrottle } from "./sessions-index-fanout-throttle.js";
import type { SessionsIndexPublisherRegistry } from "./sessions-index-publisher-registry.js";
import type { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import type { ConversationTelemetryFactNormalizer } from "./conversation-telemetry-facts.js";
import type { CuaPermissionObservationNormalizer } from "./cua-permission-observation.js";
import type { BinaryReadCacheEntry } from "./gateway-support.js";
import type { FlushState } from "./gateway-support.js";
import type { HydrationBuffer } from "./gateway-support.js";
import type { ProjectionEventCommitWaiter } from "./gateway-support.js";
import type { RawSequenceState } from "./gateway-support.js";
import type { V4GatewayHost } from "./gateway-support.js";
import type { V4SubscribeDispatchResult } from "./gateway-support.js";
import type { BackgroundBashOutputResult } from "@zcode/shared/zcode-protocol-v4";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { CommandsQueryResult } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type { QueueItem } from "@zcode/shared/zcode-protocol-v4";
import type { SessionsIndexTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type { V4AttachmentBeginResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4AttachmentChunkResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4AttachmentCommitResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4AttachmentPreviewSourceResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4AttachmentReadResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationAttachmentReadResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationAttachmentStatResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationFileRewindPreviewResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationPlansResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationRowsRangeResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationWorkflowRunArtifactDataResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationWorkflowRunArtifactReadResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationWorkflowRunArtifactsResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationWorkflowRunEventsResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationWorkflowRunNodeResultResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationWorkflowRunWorkspaceResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationWorkflowRunsResult } from "@zcode/shared/zcode-protocol-v4";
import type { WorkspaceConfigTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowTargetResolution } from "./product-projection-contract.js";
import type { StableForkCandidateResolution } from "./product-projection-contract.js";
import type { ConversationRowTargetAction } from "./product-projection.js";
import type { SessionEvent } from "@zcode/contracts";
import type { MessageWithParts } from "@zcode/contracts";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import type { WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { SessionUsageSeed } from "./product-projection.js";
import type { SessionsIndexPublisher } from "./sessions-index-publisher.js";

/** 同一 owner 的唯一内部状态 / 协作形状；不从实现类反向取型。 */
export interface ConversationV4GatewayMethodsContext {
  assertSessionRuntimeDeactivatable(sessionId: string): void;
  attachmentAbort(rawParams: unknown): Promise<void>;
  attachmentBegin(rawParams: unknown): Promise<V4AttachmentBeginResult>;
  attachmentChunk(rawParams: unknown): Promise<V4AttachmentChunkResult>;
  attachmentCommit(rawParams: unknown): Promise<V4AttachmentCommitResult>;
  attachmentPreviewSource(rawParams: unknown): Promise<V4AttachmentPreviewSourceResult>;
  readonly attachmentPruneTimer: ReturnType<typeof setInterval>;
  attachmentRead(rawParams: unknown): Promise<V4AttachmentReadResult>;
  readonly attachmentUploads: AttachmentUploadRegistry;
  backgroundBashOutput(rawParams: unknown): Promise<BackgroundBashOutputResult>;
  readonly binaryReadCache: Map<string, BinaryReadCacheEntry>;
  binaryReadCacheBytes: number;
  cleanupSessionRuntime(
    sessionId: string,
    options: { clearCommandInbox: boolean; notifyIndexRemoved: boolean },
  ): void;
  clearConnectionFlushTimers(connectionId: string): void;
  readonly coldResume: ColdSessionResumeCoordinator;
  collectMemoryDiagnostics(): Record<string, number>;
  readonly configPublishers: Map<string, WorkspaceConfigPublisher>;
  readonly controlReservations: WeakSet<object>;
  conversationAttachmentRead(rawParams: unknown): Promise<V4ConversationAttachmentReadResult>;
  conversationAttachmentStat(rawParams: unknown): Promise<V4ConversationAttachmentStatResult>;
  readonly createLogEpoch: (sessionId: string) => string;
  readonly cuaPermissionNormalizer: CuaPermissionObservationNormalizer;
  deactivateSession(sessionId: string): void;
  deleteBinaryReadCacheEntry(key: string): void;
  readonly detachedChildParent: Map<string, string>;
  readonly detachedChildrenByParent: Map<string, Set<string>>;
  readonly detachedLiveSessions: Set<string>;
  readonly detachedTerminalAt: Map<string, number>;
  dispose(): void;
  disposeSession(sessionId: string, options?: { deleted?: boolean }): void;
  disposed: boolean;
  emitLiveTelemetryFact(sessionId: string, event: SessionEvent): void;
  emitReservation<F extends RoutedTopicFrame>(reservation: TopicFrameReservation<F>): boolean;
  ensureColdReadyPublisher(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
  ): Promise<ConversationTopicPublisher>;
  ensureConfigPublisher(workspaceId: string): Promise<WorkspaceConfigPublisher>;
  ensureHistoryReadyPublisher(
    sessionId: string,
    thought?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    retryAttempt?: string,
  ): Promise<ConversationTopicPublisher>;
  ensureHostRecordForJournalRead(sessionId: string): Promise<void>;
  ensureIndexPublisher(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher>;
  ensureIndexPublisherExclusive(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher>;
  ensurePublisher(sessionId: string): ConversationTopicPublisher;
  fanOutToIndex(sessionId: string, event: SessionEvent): void;
  fileChanges(rawParams: unknown): Promise<V4ConversationFileChangesResult>;
  fileRewindPreview(rawParams: unknown): Promise<V4ConversationFileRewindPreviewResult>;
  flushConfig(workspaceId: string, onlyConnectionId?: string): void;
  flushConnection(connectionId: string): void;
  flushIndex(workspaceId: string, onlyConnectionId?: string): void;
  flushNow(subscriptionId: string): ConversationTopicFrame | null;
  readonly flushStates: Map<string, FlushState>;
  getInputRoutingMode(
    sessionId: string,
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null;
  getMessageIdForRow(sessionId: string, rowId: number): string | null;
  getMessageIdsForTurnRow(sessionId: string, rowId: number): string[];
  getOrCreateRawSequenceState(sessionId: string): RawSequenceState;
  getQueueHead(sessionId: string): {
    autoDrain: boolean;
    dispatchState: QueueItem["dispatch"]["state"];
    kind: QueueItem["kind"];
    queueItemId: string;
    text: string;
  } | null;
  getQueueItem(sessionId: string, queueItemId: string): QueueItem | null;
  getQueueLength(sessionId: string): number;
  getSessionFollowupMode(sessionId: string): "queue" | "guide" | null;
  getTurnIdForRow(sessionId: string, rowId: number): string | null;
  getTurnRewindAnchor(sessionId: string, rowId: number): string | null;
  handleCommand(rawParams: unknown): Promise<CommandAck>;
  hasConversationSubscribers(sessionId: string): boolean;
  hasLiveConversation(sessionId: string): boolean;
  hasQueueItemKind(sessionId: string, kind: QueueItem["kind"]): boolean;
  hasQueuedDelivery(sessionId: string, delivery: "guide" | "queue"): boolean;
  hasResidencyBlockingCommands(sessionId: string): boolean;
  readonly historyOpenings: Map<
    string,
    {
      history: Promise<ConversationTopicPublisher>;
      start: () => void;
      cancel: () => void;
    }
  >;
  readonly host: V4GatewayHost;
  hydratePublisher(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
    forceRebuild?: boolean,
  ): Promise<ConversationTopicPublisher>;
  readonly hydratedSessions: Set<string>;
  readonly hydrationBuffers: Map<string, HydrationBuffer>;
  readonly hydrationInFlight: Map<string, Promise<ConversationTopicPublisher>>;
  readonly inbox: CommandInbox;
  readonly indexFanoutThrottle: SessionsIndexFanoutThrottle;
  readonly indexPublishers: SessionsIndexPublisherRegistry;
  ingest(sessionId: string, event: SessionEvent): void;
  ingestDetachedLiveSession(sessionId: string, event: SessionEvent, parentSessionId?: string): void;
  ingestNormalizedEvent(sessionId: string, event: SessionEvent): void;
  isLatestAssistantSegmentRow(sessionId: string, rowId: number): boolean | null;
  isLatestEditableUserRow(sessionId: string, rowId: number): boolean | null;
  isLatestRetryAssistantRow(sessionId: string, rowId: number): boolean | null;
  readonly localTtft: LocalTtftRecorder;
  normalizeRuntimeEventSequence(sessionId: string, event: SessionEvent): SessionEvent[];
  readonly now: () => number;
  readonly pausedConnections: Set<string>;
  performHydration(
    sessionId: string,
    buffer: HydrationBuffer,
    persistedMessages?: MessageWithParts[],
    forceRebuild?: boolean,
  ): Promise<ConversationTopicPublisher>;
  plans(rawParams: unknown): Promise<V4ConversationPlansResult>;
  readonly projectionEventCommitWaiters: Map<string, Map<string, Set<ProjectionEventCommitWaiter>>>;
  readonly projectionFaultedSessions: Set<string>;
  pruneBinaryReadCache(now?: number): void;
  pruneDetachedChildPublishers(nowMs?: number, graceMs?: number): number;
  publishCurrentSummaryToIndex(sessionId: string): void;
  publishWorkspaceConfig(workspaceId: string, state: WorkspaceConfigState): void;
  readonly publishers: Map<string, ConversationTopicPublisher>;
  pullWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfigState | null>;
  queryCommands(rawParams: unknown): Promise<CommandsQueryResult>;
  readonly rawSequenceStates: Map<string, RawSequenceState>;
  readAttachmentPayload(
    sessionId: string,
    ref: string,
    mime: string,
    messageId?: string,
    attachmentIndex?: number,
    allowGeneric?: boolean,
  ): Promise<{ bytes: Uint8Array; mediaType: string }>;
  readWorkflowArtifactPayload(params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;
  readonly readyFlights: Map<string, Promise<ConversationTopicPublisher>>;
  rejectProjectionEventCommit(sessionId: string, eventId: string, error: Error): void;
  rejectProjectionEventWaiters(sessionId: string, error: Error): void;
  releaseDetachedChild(childId: string): void;
  resolveIndexMeta(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    lastOutcome?: SessionSummary["lastOutcome"];
    parentSessionId?: string;
  };
  resolveProjectionEventCommit(sessionId: string, eventId: string): void;
  resolveQueryRowTarget(
    publisher: ConversationTopicPublisher,
    params: {
      target: ConversationRowTarget;
      baseRevision: number;
      baseLogEpoch: string;
    },
    action: "fileChanges" | "fileRewindPreview",
  ): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }>;
  resolveReadableMediaAttachment(
    publisher: ConversationTopicPublisher,
    sessionId: string,
    ref: string,
    target?: { rowId: number; entityId: string },
    attachmentIndex?: number,
  ): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null;
  resolveRowActionTarget(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution | null;
  resolveStableForkCandidate(
    sessionId: string,
    rowId: number,
  ): StableForkCandidateResolution | null;
  resyncReserved(rawParams: unknown): V4SubscribeDispatchResult<RoutedTopicFrame>;
  rowsRange(rawParams: unknown): Promise<V4ConversationRowsRangeResult>;
  scheduleFlush(routeKey: string, state: FlushState, publisher: ConversationTopicPublisher): void;
  seedPublisherConfig(sessionId: string, publisher: ConversationTopicPublisher): void;
  seedPublisherUsage(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    persistedMessages?: MessageWithParts[],
    loadedSeed?: SessionUsageSeed | null,
  ): Promise<void>;
  setConnectionFlowState(rawParams: unknown): void;
  setInitialization(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    state: NonNullable<ConversationSnapshot["runtimeInitialization"]>,
  ): void;
  subscribe(rawParams: unknown): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>>;
  subscribeDispatch<F extends RoutedTopicFrame>(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<F> | null,
    afterCommit?: () => void,
  ): V4SubscribeDispatchResult<F>;
  subscribeReserved(rawParams: unknown): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>>;
  subscribeSessionsIndex(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>>;
  subscribeSessionsIndexReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>>;
  subscribeWorkspaceConfig(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>>;
  subscribeWorkspaceConfigReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>>;
  readonly telemetryEventIds: Set<string>;
  readonly telemetryNormalizer: ConversationTelemetryFactNormalizer;
  unsubscribe(rawParams: unknown): void;
  updateSharedContextImport(
    sessionId: string,
    source: ConversationSnapshot["sharedContextImport"],
  ): void;
  waitForPermissionGrantCommit(sessionId: string, eventId: string): Promise<void>;
  waitForProjectionEventCommit(
    sessionId: string,
    eventId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  workflowRunArtifactData(rawParams: unknown): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  workflowRunArtifactRead(rawParams: unknown): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  workflowRunArtifacts(rawParams: unknown): Promise<V4ConversationWorkflowRunArtifactsResult>;
  workflowRunEvents(rawParams: unknown): Promise<V4ConversationWorkflowRunEventsResult>;
  workflowRunNodeResult(rawParams: unknown): Promise<V4ConversationWorkflowRunNodeResultResult>;
  workflowRunWorkspace(rawParams: unknown): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  workflowRuns(rawParams: unknown): Promise<V4ConversationWorkflowRunsResult>;
}
