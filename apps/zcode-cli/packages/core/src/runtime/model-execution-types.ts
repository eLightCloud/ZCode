import type { TurnExecutionModelFallbackReason } from "@zcode/contracts";
import type { ContextUsageBreakdownItem, ModelRequestDependencies, ModelSelection } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type { MessageId, Model, ModelNetworkStatusEvent, ModelReasoningContentBlock, ModelStreamRecoveryStatus, ModelToolCall, ModelToolContract, ModelUsage, ModelInputMessage, PartId, SessionEvent, ToolCallId, TraceContext, TraceId, TurnId, ToolExecutionResult } from "./deps.js";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/**
 * 标准 Submission Selection 的执行期约束。它不携带 Provider/Model 静态事实，
 * 也不会成为 Session Selection 的第二份来源。
 */
export interface ModelExecutionContext {
  offPeak?: { executionId: string; ticketId: string; providerErrorCode: string };
  /** 仅当前 Turn 跳过自动 Project Memory Extraction；不修改 Session Memory 配置。 */
  memoryExtraction?: "skip";
  selectionScope: "execution";
  /** 接纳加速输入前固定的 Session 候选；仅在内存中随本条命令传递。 */
  highspeedFallbackSelection?: ModelSelection;
  requestDependencies?: ModelRequestDependencies;
  subagents?: {
    foregroundModel: "submission";
    background: "deny" | "allow";
  };
  /**
   * 本次执行的 Selection 失败时，同一 Turn 内退回原模型继续跑完（保留已提交历史，只替换后续请求的
   * 模型），而不是让整轮直接失败。触发条件必须由发起方声明：`providerId` 限定只匹配本轮 execution
   * Selection 指向的 provider，`rules` 按声明顺序匹配、首个命中决定退回原因，`providerErrorCode` 缺省
   * 表示该 provider 的任何失败。core 不按 provider id、模型名或错误文案硬编码。
   * 退回目标先取 `target`（发起方抽卡时的提交选择，即会话原模型），再取本轮接纳前复制的会话常驻 Session Selection；
   * 两者都解析不出时无处可退，按真实错误失败。
   */
  selectionFallback?: {
    providerId: string;
    rules: Array<{
      reason: TurnExecutionModelFallbackReason;
      providerErrorCode?: string;
    }>;
    target?: ModelSelection;
  };
}

export interface ProviderContextUsageSnapshot {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokens?: number;
  inputTokens: number;
  messageCount: number;
  model: { providerId: Model["providerId"]; modelId: Model["modelId"] };
  outputTokens?: number;
  recordedAt: number;
  traceId: TraceId;
  turnId?: TurnId;
}

export interface RunModelTextRequestOptions {
  toolSearchEnabled?: boolean;
  abortSignal?: AbortSignal;
  assistantMessageId: MessageId;
  events: SessionEvent[];
  maxOutputTokens?: number;
  latestRealUserMessageIndex?: number;
  messages: ModelInputMessage[];
  /** 与 messages 按索引对应的 canonical 来源，仅用于本地用量统计。 */
  sourceEntries?: readonly (RuntimeMessageEntry | undefined)[];
  model: Model;
  onStreamSnapshot?: (snapshot: RuntimeModelStreamSnapshot) => void;
  onStreamReasoningDelta?: (text: string) => void;
  onStreamTextDelta?: (text: string) => void;
  onStreamToolCall?: (toolCall: ModelToolCall) => void;
  onModelNetworkStatus?: (event: ModelNetworkStatusEvent) => void;
  streamRecovery?: ModelStreamRecoveryStatus;
  tools: ModelToolContract[];
  traceContext: TraceContext;
}

export interface RuntimeModelStreamSnapshot {
  reasoning: ModelReasoningContentBlock[];
  text: string;
}

export interface StreamedToolExecutionResult {
  input: Record<string, unknown>;
  ledgerRecorded?: boolean;
  partID: PartId;
  result: ToolExecutionResult;
  toolCallId: ToolCallId;
}

export interface RuntimeModelTextResult {
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  finishReason: string;
  providerMetadata?: Record<string, unknown>;
  reasoning?: ModelReasoningContentBlock[];
  text: string;
  toolCalls?: ModelToolCall[];
  usage: ModelUsage;
}

export type ContextUsageTokenMethod = "estimated" | "provider_count" | "proportional_estimate";

export type ContextUsageConfidence = "high" | "medium" | "low";

export interface ContextUsageMetric {
  chars: number;
  confidence: ContextUsageConfidence;
  tokenMethod: ContextUsageTokenMethod;
  tokenizer: string;
  tokens: number;
}

export interface ContextUsageCategory extends ContextUsageMetric {
  name: string;
  percentTokens: number;
  source:
    | "system_prompt"
    | "meta_user_context"
    | "skills"
    | "tool_prompt"
    | "system_tool_schemas"
    | "mcp_tool_schemas"
    | "messages";
}

export interface ContextUsageToolDetail extends ContextUsageMetric {
  name: string;
  readOnly?: boolean;
  serverName?: string;
  sideEffectScope?: string;
  source: "system_tool" | "mcp_tool";
}

export interface ContextUsageSkillDetail extends ContextUsageMetric {
  name: string;
  path: string;
  scope: string;
  source: string;
}

export interface ContextUsageMessageRoleBreakdown extends ContextUsageMetric {
  count: number;
  role: string;
}
