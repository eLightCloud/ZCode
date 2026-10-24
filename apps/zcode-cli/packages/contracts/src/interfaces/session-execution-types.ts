import type { ModelSelection } from "../model/index.js";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
// -----------------------------------------------
// Collaboration Mode and Risk Level
// -----------------------------------------------

export type CollaborationMode = "plan" | "build" | "edit" | "yolo" | "guarded" | "auto";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type TurnSteerRejectReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "turn_not_steerable"
  | "empty_input"
  | "input_too_large";

export type TurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";

export type TurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";

/**
 * 输入投递语义：
 * - "queue"：排队的未来意图，消费时切新 product turn（每条一轮，自己的回复/工时/edit 范围）；
 * - "guide"：对进行中工作的补充引导，内联在当前轮，不切轮。
 * runtime 注入机制两者相同（boundary 注入），差异只在产品呈现与账本语义。
 */
export type TurnSteerDeliveryMode = "guide" | "queue";

/** message.data metadata.highspeed 的持久化契约；不包含运行时凭据。 */
export interface HighspeedMessageMetadata {
  schemaVersion: 1;
  cardId: string;
  taskId: string;
  provider: string;
  model: string;
  issuedAt: number;
  expiresAt: number;
  regularTps?: number;
  outputTokens?: number;
  durationMs?: number;
  savedDurationMs?: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  fallbackAt?: number;
  fallbackReason?:
    | "highspeed_card_expired"
    | "highspeed_request_failed"
    | "highspeed_selection_unavailable";
}

/** 协议无关的输入 intent metadata；bootstrap v4 在事件边界组装为 ConversationInputIntent。 */
export type TurnInputSourceMetadata =
  | { kind: "pluginUi"; pluginId: string; toolCallId: string }
  | { kind: "genUi"; path: string; title?: string };

export interface TurnInputIntentMetadata {
  planEnabled?: boolean;
  conversationQuotes?: Array<{
    text: string;
    path?: string;
    senderName?: string;
    senderId?: string;
    messageId?: string;
    sentAt?: string;
  }>;
  inputOrigin?: "desktop" | "mobile";
  botGroupSource?: {
    botIdentity?: { name: string; openId?: string };
    mentionedBot?: boolean;
    appId?: string;
    contentParts?: import("@zcode/shared").ChannelContentPart[];
    messages?: Array<{
      mentionedBot?: boolean;
      messageId: string;
      senderId: string;
      senderName: string;
      text: string;
      attachmentIndexes: number[];
      contentParts?: import("@zcode/shared").ChannelContentPart[];
    }>;
    /** 入队时由 Host 注入，历史资源请求不能借用后续重新授权的版本。 */
    authorizationId?: string;
    botId: string;
    provider: "feishu" | "lark";
    chatId: string;
    threadId?: string;
    rootMessageId?: string;
    topicContext?: {
      checkpoint: string;
      hasGap: boolean;
      messages: Array<{
        id: string;
        chatId: string;
        threadId: string;
        senderId: string;
        senderType: "user" | "app";
        text: string;
        createdAt: number;
        kind: string;
        deleted?: boolean;
      }>;
    };
    senderId: string;
    senderName: string;
    messageId: string;
  };
  sourceCommandId: string;
  queueItemId: string;
  clientId: string;
  kind: TurnSteerCommandKind;
  /** transcript hydration 贯穿完整 ConversationInputIntent 的 canonical command text。 */
  text?: string;
  /** Admission 时固定；Queue/Guide 后续不得重新读取 Composer 或 Session 最新选择。 */
  modelSelection?: ModelSelection;
  /** 与本次用户 Submission 一起固定的协作模式。 */
  mode?: "build" | "edit" | "plan" | "yolo" | "guarded";
  admissionSeq: number;
  admittedAt: number;
  requestedDelivery: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery: "startNow" | "queue" | "guide";
  queuePosition?: number;
  fallbackReasonCode?: string;
  attachmentRefs?: Array<{
    ref: string;
    fileName: string;
    mime: string;
    bytes: number;
    previewRef?: string;
    sourceKind?: "clipboard-text" | "topic-history";
    messageCount?: number;
  }>;
  highspeed?: HighspeedMessageMetadata;
  sharedContextRefs?: Array<{
    kind: "shared_context_import";
    context_id: string;
  }>;
  /** edit/retry 重建的新 command 对原始 canonical input cause 的稳定追溯。 */
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
  /** 插件 UI 代发（MCP Apps ui/message）的来源；用户亲自输入时缺省。 */
  source?: TurnInputSourceMetadata;
}
