import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { CuaAppIdentity } from "@zcode/shared/zcode-protocol-v4";
import type { MutableConversationSnapshotAccumulator } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationNormalizationDiagnostic } from "./event-normalizer.js";
import type { ContextWindowProjectionState } from "./product-projection-contract.js";
import type { ConversationEditTarget } from "./product-projection-contract.js";
import type { FileToolInputPreviewState } from "./product-projection-contract.js";
import type { HighspeedToolInterval } from "./product-projection-contract.js";
import type { PendingSessionHookInvocation } from "./product-projection-contract.js";
import type { TurnModelBaseline } from "./product-projection-contract.js";
import type { SessionEvent } from "@zcode/contracts";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowTargetAction } from "./product-projection-contract.js";
import type { ConversationRowTargetResolution } from "./product-projection-contract.js";
import type { StableForkCandidateResolution } from "./product-projection-contract.js";
import type { SubagentRow } from "@zcode/shared/zcode-protocol-v4";
import type { SessionConfigSeed } from "./product-projection-contract.js";
import type { SessionSubagentsSeed } from "./product-projection-contract.js";
import type { SessionUsageSeed } from "./product-projection-contract.js";
import type { AvailabilityContext } from "./projection-state.js";
import type { GoalState } from "@zcode/shared/zcode-protocol-v4";
import type { SessionControl } from "@zcode/shared/zcode-protocol-v4";
import type { StatePatch } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { HookExecutionProjection } from "@zcode/shared/zcode-protocol-v4";
import type { CanonicalConversationFact } from "./event-normalizer.js";
import type { TargetCompletionVerificationPayload } from "@zcode/contracts";
import type { HookRunLifecyclePayload } from "@zcode/contracts";
import type { HookInvocationRow } from "@zcode/shared/zcode-protocol-v4";
import type { PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import type { CanonicalAssistantSegmentFact } from "./event-normalizer.js";
import type { ApiRetryState } from "@zcode/shared/zcode-protocol-v4";
import type { PermissionRequestedPayload } from "@zcode/contracts";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { CanonicalOpenSegmentIdentity } from "./event-normalizer.js";
import type { TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { extractPlanStepsFromToolInput } from "@zcode/shared";
import type { CanonicalModelStream } from "./event-normalizer.js";
import type { CanonicalUserIntentFact } from "./event-normalizer.js";
import type { TurnWorkSegment } from "@zcode/shared/zcode-protocol-v4";

/** 同一 owner 的唯一内部状态 / 协作形状；不从实现类反向取型。 */
export interface ProductProjectionContext {
  acceptsActiveModelEvent(event: SessionEvent): boolean;
  activeMsForCompletion(event: SessionEvent, runtimeDuration?: number): number | undefined;
  adoptProjection(candidate: ProductProjectionContext): void;
  appendStreamingToolInput(event: SessionEvent, payload: CanonicalModelStream): ConversationDelta[];
  applyBackgroundTaskNotification(fact: CanonicalUserIntentFact): ConversationDelta[];
  applyEvent(event: SessionEvent): ConversationDelta[];
  applyEventAtomically(
    event: SessionEvent,
    accept: (snapshot: ConversationSnapshot, deltas: readonly ConversationDelta[]) => boolean,
  ): ConversationDelta[] | null;
  applyEventInternal(event: SessionEvent, materializeActions: boolean): ConversationDelta[];
  applyHydrationEvent(event: SessionEvent): ConversationDelta[];
  attachRevision(deltas: ConversationDelta[]): ConversationDelta[];
  beginHydrationReplay(): void;
  cloneProjection(): ProductProjectionContext;
  closeOpenToolRows(
    event: SessionEvent,
    status: "cancelled" | "error",
    only?: (row: ToolCallRow) => boolean,
  ): ConversationDelta[];
  closeReasoningRow(state?: "complete" | "interrupted"): ConversationDelta[];
  closeStreamingRows(state: "complete" | "interrupted"): ConversationDelta[];
  closeTextRow(state: "complete" | "interrupted"): ConversationDelta[];
  compactMarkerRowIdByOperationId: Map<string, number>;
  completeHydrationReplay(): ConversationDelta[];
  completeWorkSegments(segments: readonly TurnWorkSegment[], endedAt: number): TurnWorkSegment[];
  configModeTouchedByEvent: boolean;
  configModelTouchedByEvent: boolean;
  configThoughtLevelsTouchedByEvent: boolean;
  contextWindowState: ContextWindowProjectionState;
  controlPatch(
    control: Partial<SessionControl>,
    goal?: GoalState | null,
    queue?: ConversationSnapshot["queue"],
  ): StatePatch;
  createPendingInteractionFromPermissionEvent(
    event: SessionEvent,
    payload: PermissionRequestedPayload,
    toolCallId: string,
    interactionId: string,
  ): PendingInteraction;
  currentEditableEntityId: string | null;
  currentProductTurnStartedAtMs: number | null;
  currentTurnId: string | null;
  currentTurnStartedModelOnly: boolean;
  deliveryByPendingInputId: Map<string, "guide" | "queue">;
  deriveContext(overrides: {
    goal?: GoalState | null;
    queue?: ConversationSnapshot["queue"];
  }): AvailabilityContext;
  droppedContentStreamEventCount: number;
  editTargetByEntityId: Map<string, ConversationEditTarget>;
  entityIdByRowId: Map<number, string>;
  establishedStreamingAppend(event: SessionEvent): string | null;
  fileToolInputPreviewByCallId: Map<string, FileToolInputPreviewState>;
  finalizeStreamingToolInput(
    event: SessionEvent,
    payload: CanonicalModelStream,
  ): ConversationDelta[];
  findRow(rowId: number): ConversationRow | undefined;
  findSubagentLifecycleRow(
    agentId: string,
    payload: Record<string, unknown>,
    event: SessionEvent,
  ): SubagentRow | undefined;
  findSubagentRow(agentId: string): SubagentRow | undefined;
  findToolRow(toolCallId: string): ToolCallRow | undefined;
  flushPendingSessionHookInvocations(turnId: string): ConversationDelta[];
  flushStreamingToolInput(toolCallId: string): ConversationDelta[];
  getDroppedContentStreamEventCount(): number;
  getEntityIdForRow(rowId: number): string | null;
  getMessageIdForRow(rowId: number): string | null;
  getMessageIdsForTurnRow(rowId: number): string[];
  getNormalizationDiagnostics(): readonly ConversationNormalizationDiagnostic[];
  getSnapshot(): ConversationSnapshot;
  getTurnIdForRow(rowId: number): string | null;
  getTurnRewindAnchor(rowId: number): string | null;
  goalPatch(goal: GoalState | null): StatePatch;
  goalVerifyLifecycleKey(payload: TargetCompletionVerificationPayload, iteration: number): string;
  goalVerifyMarkerRowIdByLifecycleKey: Map<string, number>;
  goalVerifyTurnId(payload: TargetCompletionVerificationPayload, event: SessionEvent): string;
  highspeedModelDurationByTurnId: Map<string, number>;
  highspeedTimingForTurn(
    turnId: string,
    activeMs?: number,
  ): { modelDurationMs: number; toolDurationMs: number; otherDurationMs: number } | undefined;
  highspeedToolIntervalsByTurnId: Map<string, Map<string, HighspeedToolInterval>>;
  hookBlockErrorDelta(
    event: SessionEvent,
    payload: HookRunLifecyclePayload,
    didExecute: boolean,
    blockReason: string | undefined,
  ): ConversationDelta | null;
  hookExecutionOutcome(
    eventType: SessionEvent["type"],
    outcome: HookRunLifecyclePayload["outcome"],
  ): HookExecutionProjection["outcome"];
  hookExecutionState(eventType: SessionEvent["type"]): HookExecutionProjection["state"];
  hookInvocationLane(
    eventName: HookRunLifecyclePayload["hookEventName"],
  ): HookInvocationRow["lane"];
  hookInvocationState(
    executions: readonly HookExecutionProjection[],
    hookCount: number,
  ): HookInvocationRow["state"];
  hookRowIdByInvocationId: Map<string, number>;
  hydrationAccumulator: MutableConversationSnapshotAccumulator | null;
  invalidSubagentChildSessionIds: Set<string>;
  isLatestAssistantSegmentRow(rowId: number): boolean;
  isLatestEditableUserRow(rowId: number): boolean;
  isLatestRetryAssistantRow(rowId: number): boolean;
  isMirroredSubagentToolEvent(event: SessionEvent): boolean;
  isOpenForegroundToolRow(row: ToolCallRow): boolean;
  isRunning(): boolean;
  lastTurnModel: TurnModelBaseline;
  latestListAppsSnapshot: Map<number, CuaAppIdentity>;
  leaveDraftAfterControlOnlyTurn(
    phase: Exclude<SessionControl["phase"], "draft" | "prewarming" | "running">,
  ): ConversationDelta[];
  mapSubagentStatus(status: string | undefined): SubagentRow["status"];
  markStableForkAssistant(event: SessionEvent): ConversationDelta[];
  materializeCommandRowActions(reduced: ConversationDelta[]): ConversationDelta[];
  materializeSubagentProjection(reduced: readonly ConversationDelta[]): ConversationDelta[];
  messageIdByRowId: Map<number, string>;
  ms(event: SessionEvent): number;
  nextRowId: number;
  normalizationDiagnostics: ConversationNormalizationDiagnostic[];
  onAssistantFeedbackUpdated(event: SessionEvent): ConversationDelta[];
  onBackgroundTaskLifecycle(event: SessionEvent): ConversationDelta[];
  onCompactLifecycle(event: SessionEvent): ConversationDelta[];
  onDynamicWorkflowRunProgress(event: SessionEvent): ConversationDelta[];
  onFollowupModeChanged(event: SessionEvent): ConversationDelta[];
  onHighspeedMetricsUpdated(event: SessionEvent): ConversationDelta[];
  onHookRunLifecycle(event: SessionEvent): ConversationDelta[];
  onModelComplete(event: SessionEvent): ConversationDelta[];
  onModelNetworkStatus(event: SessionEvent): ConversationDelta[];
  onModelSelected(event: SessionEvent): ConversationDelta[];
  onModelStreaming(fact: CanonicalAssistantSegmentFact): ConversationDelta[];
  onPermissionDenied(event: SessionEvent): ConversationDelta[];
  onPermissionRequested(event: SessionEvent): ConversationDelta[];
  onPermissionResolved(event: SessionEvent): ConversationDelta[];
  onQueueAutoDrainChanged(event: SessionEvent): ConversationDelta[];
  onRewindTriggered(event: SessionEvent): ConversationDelta[];
  onSessionCreated(event: SessionEvent): ConversationDelta[];
  onSessionForked(event: SessionEvent): ConversationDelta[];
  onSessionInputPromoted(event: SessionEvent): ConversationDelta[];
  onSessionModeChanged(event: SessionEvent): ConversationDelta[];
  onSessionResumed(event: SessionEvent): ConversationDelta[];
  onSessionTitleUpdated(event: SessionEvent): ConversationDelta[];
  onStreamRecoveryRetryStarted(event: SessionEvent): ConversationDelta[];
  onStreamRecoveryStarted(event: SessionEvent): ConversationDelta[];
  onStreamRecoveryTailDiscarded(event: SessionEvent): ConversationDelta[];
  onStreamingToolIdentity(event: SessionEvent): ConversationDelta[];
  onSubagentMessage(event: SessionEvent): ConversationDelta[];
  onSubagentSpawned(event: SessionEvent): ConversationDelta[];
  onSubagentStopped(event: SessionEvent): ConversationDelta[];
  onTargetChanged(event: SessionEvent): ConversationDelta[];
  onTargetVerification(event: SessionEvent): ConversationDelta[];
  onToolCallActivity(event: SessionEvent): ConversationDelta[];
  onToolCallError(event: SessionEvent): ConversationDelta[];
  onToolCallProgress(event: SessionEvent): ConversationDelta[];
  onToolCallResult(event: SessionEvent): ConversationDelta[];
  onToolCallScheduled(event: SessionEvent): ConversationDelta[];
  onTurnComplete(event: SessionEvent): ConversationDelta[];
  onTurnError(event: SessionEvent): ConversationDelta[];
  onTurnExecutionModelFallback(event: SessionEvent): ConversationDelta[];
  onTurnStarted(fact: CanonicalUserIntentFact): ConversationDelta[];
  onTurnSteerDeliveryChanged(event: SessionEvent): ConversationDelta[];
  onTurnSteerDiscarded(event: SessionEvent): ConversationDelta[];
  onTurnSteerDispatchChanged(event: SessionEvent): ConversationDelta[];
  onTurnSteerDrained(event: SessionEvent): ConversationDelta[];
  onTurnSteerQueued(event: SessionEvent): ConversationDelta[];
  onTurnSteerReordered(event: SessionEvent): ConversationDelta[];
  onUserInputAutoResolutionUpdated(event: SessionEvent): ConversationDelta[];
  onWorkspaceHookAdmissionUpdated(event: SessionEvent): ConversationDelta[];
  onWorkspaceHookReviewRequested(event: SessionEvent): ConversationDelta[];
  onWorkspaceHookReviewSettled(event: SessionEvent): ConversationDelta[];
  onWorkspaceHookReviewSuperseded(event: SessionEvent): ConversationDelta[];
  openAssistantSegments(): Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>>;
  openForegroundToolCallIds: Set<string>;
  openGuidedWorkSegment(event: SessionEvent, triggerEntityId: string): ConversationDelta[];
  openReasoningRow(event: SessionEvent, fact: CanonicalAssistantSegmentFact): ConversationDelta[];
  openSegmentIdentity(rowId: number | null): CanonicalOpenSegmentIdentity | null;
  openTextRow(event: SessionEvent, fact: CanonicalAssistantSegmentFact): ConversationDelta[];
  openToolRow(
    event: SessionEvent,
    payload: CanonicalModelStream,
    entityId?: string,
  ): ConversationDelta[];
  outputContinuationRowIdByMessageId: Map<string, number>;
  outputContinuationTextRowId: number | null;
  pendingSessionHookInvocations: Map<string, PendingSessionHookInvocation>;
  productTurnIdByRuntimeTurnId: Map<string, string>;
  productTurnSplitOrdinalByRuntimeTurnId: Map<string, number>;
  prospectiveSubagentRow(
    row: ConversationRow,
    reduced: readonly ConversationDelta[],
    startIndex: number,
  ): SubagentRow | null;
  pruneRemovedSubagentIndexes(): void;
  queuePatch(queue: ConversationSnapshot["queue"]): StatePatch;
  recordHighspeedToolEnded(
    turnId: string,
    toolCallId: string,
    endedAt: number,
    durationMs?: number,
  ): void;
  recordHighspeedToolStarted(turnId: string, toolCallId: string, startedAt: number): void;
  reduce(fact: CanonicalConversationFact): ConversationDelta[];
  registerCanonicalUserRowTarget(
    rowId: number,
    entityId: string,
    editTarget?: ConversationEditTarget,
  ): void;
  removeQueueItems(ids: readonly string[]): ConversationDelta[];
  removeWorkspaceHookReview(interactionId: string): ConversationDelta[];
  resolveEditTarget(rowId: number): ConversationEditTarget | null;
  resolveEditTargetByEntityId(entityId: string): ConversationEditTarget | null;
  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution;
  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution;
  resumedSubagentBackgroundWorkDelta(
    event: SessionEvent,
    payload: Record<string, unknown>,
    agentId: string,
    childSessionId: string | undefined,
  ): ConversationDelta | undefined;
  rewindAnchorForRows(rows: readonly ConversationRow[], rowId: number): string | null;
  rewoundHookInvocationIds: Set<string>;
  rowBase(
    event: SessionEvent,
    turnId: string,
    entityId?: string,
  ): Required<
    Pick<
      ConversationRow,
      | "rowId"
      | "turnId"
      | "entityId"
      | "productTurnId"
      | "visibility"
      | "createdAt"
      | "createdAtSeq"
    >
  >;
  rowIdForMessageId(messageId: string): number | null;
  rowIndexById: Map<number, number>;
  runtimeTurnIdByProductTurnId: Map<string, string>;
  seedConfig(seed: SessionConfigSeed): void;
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void;
  seedSubagents(seed: SessionSubagentsSeed): void;
  seedUsage(seed: SessionUsageSeed): void;
  setApiRetry(apiRetry: ApiRetryState | null): ConversationDelta[];
  settlePermission(toolCallId: string, status: ToolCallRow["status"]): ConversationDelta[];
  shouldMaterializeSubagentProjection(reduced: readonly ConversationDelta[]): boolean;
  snapshot: ConversationSnapshot;
  splitProductTurn(
    event: SessionEvent,
    runtimeTurnId: string,
    promotedUserMessageId?: string,
  ): ConversationDelta[];
  stableCompactCoverageBoundaryRowId: number | null;
  streamRecoveryApiRetry(
    retryNumber: number,
    maxRetriesValue: number,
    nextRetryAt: number,
    reasonCode: string,
  ): ApiRetryState;
  streamingReasoningRowId: number | null;
  streamingTextRowId: number | null;
  stringPayload(payload: Record<string, unknown>, key: string): string | undefined;
  subagentAgentId(payload: Record<string, unknown>, event: SessionEvent): string;
  subagentRowIdByAgentId: Map<string, number>;
  takePendingStreamingToolInput(toolCallId: string): string;
  todoPlanDeltas(
    event: SessionEvent,
    steps: ReturnType<typeof extractPlanStepsFromToolInput>,
  ): ConversationDelta[];
  toolRowIdByCallId: Map<string, number>;
  turnHeaderForEvent(event: SessionEvent): TurnHeaderRow | undefined;
  turnHeaderRowIdByTurnId: Map<string, number>;
  turnIdOf(event: SessionEvent): string;
  updateRowIndexAfterImmutableApply(
    previousRowsLength: number,
    deltas: readonly ConversationDelta[],
  ): void;
  updateToolIndexesAfterDeltas(deltas: readonly ConversationDelta[]): void;
  upsertTurnHeader(
    event: SessionEvent,
    state: "completedSuccess" | "completedInterrupted" | "failed",
    activeMs?: number,
    historyRoundCount?: number,
    highspeedTiming?: {
      modelDurationMs: number;
      toolDurationMs: number;
      otherDurationMs: number;
    },
  ): ConversationDelta[];
}
