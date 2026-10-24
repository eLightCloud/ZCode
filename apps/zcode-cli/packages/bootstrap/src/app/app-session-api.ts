import type {
  CollaborationMode,
  ModelSelection,
  SessionGoal,
  SessionId,
  SupportedLocale,
  TodoItem,
  ToolArtifactReadResult,
  TraceContext,
  UiLocale,
  UiThemePreference,
} from "@zcode/contracts";

import type { AgentRuntime, ExpertWorkflowCommandResult, ResumeSessionResult } from "@zcode/core";

import type { ZCodeModelOption } from "@zcode/shared";

import type { SessionTranscriptMessage } from "../session-transcript.js";

import type {
  PromptInput,
  RespondWorkspaceHookReviewInput,
  ResumeOptions,
  RevokeWorkspaceHookTrustInput,
  SendInputOptions,
  SendInputResult,
  SetLocaleResult,
  SubmitPromptOptions,
  ToggleWorkspaceHookReviewItemInput,
} from "./app-option-types.js";
import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-controller.js";
export interface AppSessionApi {
  readonly sessionId: SessionId;

  readonly traceId: string;

  readonly runtime: AgentRuntime;

  respondWorkspaceHookReview(
    input: RespondWorkspaceHookReviewInput,
  ): Promise<WorkspaceHookReviewCommandResult>;

  toggleWorkspaceHookReviewItem(
    input: ToggleWorkspaceHookReviewItemInput,
  ): Promise<WorkspaceHookReviewCommandResult & { request?: unknown }>;

  revokeWorkspaceHookTrust(
    input: RevokeWorkspaceHookTrustInput,
  ): Promise<WorkspaceHookReviewCommandResult>;

  /** 软门禁:按需开审核 flow,无 pending 项时为安全 no-op */
  requestWorkspaceHookReview(input: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;

  /**
   * Trust store 落盘后本 session 的 coordinator
   * 内存镜像不会自动更新（per-session，仅创建时 load 一次）。Settings 无 task 的
   * pretrust 授权成功后，server 会按 workspace 逐个调用本方法，把文件重载进
   * coordinator 并重发 admission 状态，否则已信任 Hook 继续被拒、banner 不刷新。
   */
  reloadWorkspaceHookTrust(): Promise<void>;

  close?(): Promise<void>;

  getMode(): CollaborationMode;

  getModel(): string;

  /** current-only 协议快照精确读取当前 Registry 模型，避免枚举整个目录。 */
  getCurrentModelOption?(): ZCodeModelOption | undefined;

  /** 只读 Registry 元数据；不要求选项完整，也不绑定执行模型。 */
  getModelOption?(selection: ModelSelection): ZCodeModelOption | undefined;

  getLocale(): SupportedLocale;

  getTheme(): UiThemePreference;

  getDefaultThoughtLevel(): string | undefined;

  getThoughtLevel(): string | undefined;

  loadSessionTranscript(): Promise<SessionTranscriptMessage[]>;

  readSubagents(input?: {
    endedCursor?: string;
    endedLimit?: number;
  }): Promise<import("@zcode/shared").ZCodeSessionSubagentsResult>;

  readSubagentTranscript(
    childSessionId: string,
  ): Promise<import("./subagent-observation.js").SubagentTranscriptSnapshot>;

  readTodos(): Promise<TodoItem[]>;

  readTarget(): Promise<SessionGoal | null>;

  setCustomSessionTitle(input: { title: string; traceContext?: TraceContext }): Promise<void>;

  readToolResultArtifact(uri: string): Promise<ToolArtifactReadResult>;

  /** chunk transaction commit 后把完整二进制原子寄存到 session artifact store。 */
  writePromptAttachment(input: {
    fileName: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;

  /** 已发送 image/video 预览：在拥有 session 的 runtime 内读取 artifact 或实际路径。 */
  readPromptAttachment(input: {
    ref: string;
    mime: string;
    maxBytes: number;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;

  /** Share 选择阶段只读 userInput 附件元数据；不读取完整内容。 */
  statPromptAttachment?(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;

  /** Desktop local 已发送视频：解析 artifact-first 本地播放源；否则保持分片读取。 */
  resolvePromptAttachmentPreviewSource(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ kind: "local_path"; path: string; mediaType: string } | { kind: "chunked" }>;

  resume(options?: ResumeOptions): Promise<ResumeSessionResult>;

  resumeExpertWorkflow(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;

  resumeWorkflow?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;

  sendInput(input: PromptInput, options?: SendInputOptions): Promise<SendInputResult>;

  setMode(mode: CollaborationMode): Promise<{
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceId: TraceContext["traceId"];
  }>;

  setModelIoFullRetentionEnabled?(enabled: boolean): void;

  setModel(
    modelId: string | ModelSelection,
    options?: {
      /**
       * per-turn（off-peak idle plan）：true = 仅切运行态——不写磁盘模型选择、
       * 不产出 modelChange 聊天通知。用于 turn 级临时切换（应用/还原成对出现）。
       */
      transient?: boolean;
    },
  ): Promise<{
    model: string;
    previousModel: string;
    thoughtLevel?: string;
    traceId: TraceContext["traceId"];
  }>;

  setThoughtLevel(level: string): Promise<{
    previousThoughtLevel?: string;
    thoughtLevel: string;
    traceId: TraceContext["traceId"];
  }>;

  setLocale(locale: UiLocale): Promise<SetLocaleResult>;
}
