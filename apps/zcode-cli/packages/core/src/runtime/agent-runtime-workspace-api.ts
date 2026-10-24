import type { MessageId, SessionEvent, SessionId, TraceContext, TurnId } from "./deps.js";

import type { ModelConnectivityTestInput, WorkspaceGenerateTextInput, WorkspaceGenerateTextResult } from "./methods/workspace-generate-text.js";

import type { ConversationBeforeInputForkOptions, ConversationRewindResult, SelectionSideChatCreateOptions, StableConversationForkOptions, WorkspaceCheckpointSummary, WorkspaceFileRewindApplyResult, WorkspaceFileRewindPreview, WorkspaceForkResult } from "./workspace-recovery-types.js";

export interface AgentRuntimeWorkspaceApi {
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

  /**
   * conversation edit/retry 的 same-session branch cut primitive。
   *
   * 该入口故意不经过 executeTurn command queue：组合文件 rewind 会在文件事务的
   * commit gate 内调用它；若再排队 `/rewind`，当前 edit command 会等待自己释放队列。
   */
  rewindConversationToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult>;

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

  sampleModel(
    input: import("./methods/sample-model.js").SampleModelInput,
    options: { abortSignal: AbortSignal; traceContext?: TraceContext },
  ): Promise<import("@zcode/shared/mcp-apps").McpAppsSamplingResult>;

  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<WorkspaceGenerateTextResult>;

  testModelConnectivity(
    input: ModelConnectivityTestInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;

  isProjectMemoryEnabled(): boolean;

  /** 缺省等待最多 60 秒；null 等待全部已调度提取结束，不设置 drain deadline。 */
  drainMemoryExtractions(timeoutMs?: number | null): Promise<void>;
}
