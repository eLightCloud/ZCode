import type {
  CheckpointCreatedPayload,
  MessageId,
  MessageWithParts,
  RewindScope,
  RewindTargetEvaluation,
  SessionEvent,
  SessionId,
  TraceContext,
  TurnId,
  WorkspaceCheckpointArtifact,
} from "./deps.js";

import type {
  ConversationBeforeInputForkOptions,
  ConversationRewindResult,
  ParsedRewindCommand,
  SelectionSideChatCreateOptions,
  StableConversationForkOptions,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
} from "./types.js";

export interface InternalTurnRewindMethods {
  executeRewindCommand(
    input: string,
    command: ParsedRewindCommand,
    turnId: TurnId,
    turnTraceContext: TraceContext,
    abortSignal?: AbortSignal,
    inputId?: string,
  ): Promise<TurnResult>;

  formatRewindStatus(): Promise<string>;

  rewindWorkspaceToCheckpoint(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetCheckpointId?: string;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;

  rewindToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult | WorkspaceRewindResult>;

  rewindCascadeToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult | WorkspaceRewindResult>;

  rewindConversationToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult>;

  rewindWorkspaceToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;

  finishUnavailableRewind(options: {
    checkpoint?: CheckpointCreatedPayload;
    evaluation?: RewindTargetEvaluation;
    events: SessionEvent[];
    reason: string;
    rewindId: string;
    scope?: RewindScope;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;

  restoreWorkspaceCheckpointArtifact(
    artifact: WorkspaceCheckpointArtifact,
    traceContext: TraceContext,
    abortSignal?: AbortSignal,
  ): Promise<WorkspaceRewindRestoredFile[]>;

  copySessionMessagesForFork(options: {
    forkedSessionId: SessionId;
    messages: MessageWithParts[];
    traceContext: TraceContext;
  }): Promise<{
    copiedMessageCount: number;
    messageIdMap: Map<MessageId, MessageId>;
  }>;

  listWorkspaceCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;

  forkWorkspaceFromCheckpoint(options?: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;

  forkStableConversationAtMessage(
    options: StableConversationForkOptions,
  ): Promise<WorkspaceForkResult>;

  createSelectionSideConversation(
    options: SelectionSideChatCreateOptions,
  ): Promise<WorkspaceForkResult>;

  forkConversationBeforeMessage(
    options: ConversationBeforeInputForkOptions,
  ): Promise<WorkspaceForkResult>;

  previewWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceFileRewindPreview>;

  applyWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
    commitAfterApply?: () => Promise<void>;
  }): Promise<WorkspaceFileRewindApplyResult>;

  loadCheckpointMessagePreviews(): Promise<Map<MessageId, string>>;
}
