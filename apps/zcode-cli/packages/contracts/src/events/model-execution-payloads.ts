import type { ModelMessage, TokenUsage } from "./execution-event-values.js";
import { type ErrorPayload } from "./session-error-facts.js";
import type { HttpClientEgressInfo } from "../interfaces/http-client.port.js";
import type { MessageId, PartId, ToolCallId } from "../interfaces/shared.js";
import type { ModelNetworkStatusEvent, ModelSelection, ModelUsage } from "../model/index.js";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface ModelRequestPayload {
  messages: ModelMessage[];
  providerId: string;
  modelId: string;
  querySource?: string;
  temperature?: number;
  maxTokens?: number;
}

export type ModelSelectionOrigin = "registryFallback";

export interface ModelSelectedPayload {
  modelSelection: ModelSelection;
  /** Active Model 已解析出的 reasoning，仅供执行事实/展示投影，不属于稀疏 Selection。 */
  effectiveReasoningLevel?: string;
  /** 缺失表示只更新当前选型；null 表示显式 ∅→selection 模型边界。 */
  previousModelSelection?: ModelSelection | null;
  /** 只有 Agent 自动恢复模型时携带；缺失表示普通选型或旧事件。 */
  origin?: ModelSelectionOrigin;
  /** 当前 selection 对应的思考档位能力；与模型选型同事件原子发布。 */
  supportedThoughtLevels?: string[];
  /** 当前 selection 在 runtime 实际应用的上下文窗口；null 表示显式清除，字段缺失兼容旧事件。 */
  contextWindow?: number | null;
}

/**
 * 执行 Selection 退回会话 Selection 的原因，与 @zcode/shared 的 selectionFallback 规则同值域：
 * 卡过期由声明的 provider 错误码命中，其余任何加速请求失败归为 request_failed。
 */
export type TurnExecutionModelFallbackReason =
  | "highspeed_card_expired"
  | "highspeed_request_failed"
  | "highspeed_selection_unavailable";

export interface TurnExecutionModelFallbackPayload {
  inputId?: string;
  reason: TurnExecutionModelFallbackReason;
  /**
   * Provider 重构后单轮执行模型统一用稀疏 Selection 表达（旧的 ModelRef 已删除）：
   * from 是本轮 execution 作用域的加速 Selection，to 是会话常驻 Selection。
   */
  fromModelSelection: ModelSelection;
  toModelSelection: ModelSelection;
}

export type ModelStreamingKind =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "reasoning_start"
  | "reasoning_delta"
  | "reasoning_end"
  | "tool_input_start"
  | "tool_input_delta"
  | "tool_input_end"
  | "tool_call"
  | "finish"
  | "error";

export interface ModelStreamingPayload {
  delta: string;
  done: boolean;
  kind?: ModelStreamingKind;
  assistantMessageId?: MessageId;
  partId?: PartId;
  toolCallId?: ToolCallId;
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

export type ModelNetworkStatusPayload = ModelNetworkStatusEvent;

export type ModelAnomalyWarningCategory =
  | "tool_call_budget"
  | "repeated_tool_call"
  | "provider_finish_mismatch"
  | "malformed_tool_call";

export type ModelAnomalyWarningSeverity = "info" | "warning";

export interface ModelAnomalyWarningPayload {
  category: ModelAnomalyWarningCategory;
  severity: ModelAnomalyWarningSeverity;
  observedCount?: number;
  threshold?: number;
  toolName?: string;
  toolCallId?: ToolCallId;
  warningInjected: boolean;
  modelVisibleMessageId?: MessageId;
}

export type NetworkRequestSource = "http_client" | "model" | "tool" | "mcp" | "plugin" | "unknown";

export type NetworkRequestLifecycleStatus = "pending" | "complete" | "error";

export interface NetworkRequestStatusPayload {
  requestId: string;
  source: NetworkRequestSource;
  status: NetworkRequestLifecycleStatus;
  method: string;
  url: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  statusCode?: number;
  error?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  attempt?: number;
  egress?: HttpClientEgressInfo;
}

export interface ModelCompletePayload {
  cacheHit?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    latestHitRate: number | null;
    hitRate: number | null;
    hitRateRequestCount: number;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
  };
  content: string;
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  contextWindow?: number;
  fileChanges?: TurnFileChangeSummary;
  querySource?: string;
  stopReason: string;
  /** 当前模型请求组装出的完整 tool call 数量；旧事件可能缺失。 */
  toolCallCount?: number;
  usage: TokenUsage | ModelUsage;
}

export interface TurnFileChangeSummary {
  additions: number;
  deletions: number;
  files: number;
  items: TurnFileChangeSummaryItem[];
}

export interface TurnFileChangeSummaryItem {
  additions: number;
  deletions: number;
  path: string;
  toolNames?: string[];
  writeCount: number;
}

export type ContextUsageBreakdownSource =
  | "system_prompt"
  | "meta_user_context"
  | "skills"
  | "tool_prompt"
  | "system_tool_schemas"
  | "mcp_tool_schemas"
  | "messages";

export interface ContextUsageBreakdownItem {
  source: ContextUsageBreakdownSource;
  chars: number;
}

export interface ModelErrorPayload {
  error: ErrorPayload;
  retryable: boolean;
}
