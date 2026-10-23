import type {
  CollaborationMode,
  Model,
  ModelSelection,
  ModelSelectionOrigin,
  TraceContext,
  TurnState,
  TurnSteerInput,
  TurnSteerResult,
} from "./deps.js";

import type {
  AcquireForegroundPromotionLeaseResult,
  ActiveTurnInfo,
  ForegroundPromotionLeaseMode,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
} from "./types.js";

export interface AgentRuntimeInputApi {
  getActiveTurnInfo(): ActiveTurnInfo | undefined;

  admitPrompt(
    input: string,
    attachments?: TurnState["attachments"],
    options?: PromptAdmissionOptions,
  ): Promise<PromptAdmissionReceipt>;

  /** Session 常驻池使用的 runtime busy 权威事实，包含 queue/drain/reservation。 */
  hasActiveOrQueuedTurnWork(): boolean;

  /** Session 常驻池使用的后台 Bash/Agent/Workflow running 权威事实。 */
  hasRunningBackgroundTasks(): boolean;

  /**
   * Session 常驻池唯一消费的 runtime owned-work 聚合事实。
   * 包含前台/队列、registry background task、detached sidecar 和 memory work。
   */
  hasResidencyBlockingWork(): boolean;

  /**
   * 登记一段会越过当前同步调用栈的 runtime-owned work，计数在**本同步片**增加、在 promise 的
   * finally 释放（实现见 runtime/methods/residency.ts）。
   *
   * 公开在这一面上，是因为 runtime 之外的 sidecar 也要经同一个口登记：dwf 引擎跑在会话 App 里、
   * 不进 runtime task registry，因此出现「引擎在飞时会话被按 idle 关掉」。
   * 新增 sidecar 一律登记到这里，而不是在 bootstrap 侧另加一条猜测。
   */
  trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T>;

  /**
   * 会话是否已落进持久化 store。协议层 record 的 draft（deferred）判定以此为事实源：任何经 runtime
   * 首次持久化的路径（首条输入、外部活动、中枢直接启动的启动轮）都会让会话离开 draft。
   */
  isSessionPersisted(): boolean;

  getActiveForegroundExecutionId(): string | undefined;

  acquireForegroundPromotionLease(options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  }): AcquireForegroundPromotionLeaseResult;

  releaseForegroundPromotionLease(leaseId: string): boolean;

  enqueueDeferredInput(input: string | TurnSteerInput): Promise<TurnSteerResult>;

  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;

  /** v4 queue 单项删除：按 pendingInputId 移除当前 active turn 的一条排队输入。 */
  removePendingInputById(options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;

  reservePendingInputById(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;

  markPendingInputPromoting(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;

  releasePendingInputReservation(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;

  /** v4 queue 单项编辑：按 pendingInputId 替换排队输入文本（保位）。 */
  editPendingInputById(options: {
    pendingInputId: string;
    newText: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;

  /** v4 queue 重排：移动 pendingInputId 到 beforePendingInputId 之前（null=队尾）。 */
  reorderPendingInput(options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext?: TraceContext;
  }): Promise<boolean>;

  /**
   * v4 heldQueueDisposition=clearQueueAndSend 执行件：
   * 清空全部排队输入（active turn 内存项 + held 投影残留），返回丢弃条数。
   */
  clearAllPendingInputs(traceContext: TraceContext): Promise<number>;

  /** v4 setAutoDrain：翻转 queue autoDrain 授权位（会话级）。 */
  setQueueAutoDrain(options: { autoDrain: boolean; traceContext?: TraceContext }): Promise<void>;

  /** 暂停队列外层 FIFO 已消费到空，恢复后续 running queue 的行内 drain。 */
  completeExternalQueueDrain(): void;

  /** v4 setFollowupMode：翻转 followup 路由模式（queue/guide，会话级）。 */
  setFollowupMode(options: { mode: "queue" | "guide"; traceContext?: TraceContext }): Promise<void>;

  /** v4 switchModelConfig：模型选型变化后补发 ModelSelected（config/marker 投影）。 */
  emitModelSelected(options: {
    modelSelection: ModelSelection;
    model?: Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext?: TraceContext;
  }): Promise<void>;

  /** v4 switchCollaborationMode：协作模式切换后补发 SessionModeChanged（config.mode 投影）。 */
  emitModeChanged(options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  }): Promise<void>;
}
