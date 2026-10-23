import type { BackgroundBashOutputResult } from "@zcode/shared";

import type {
  BackgroundTaskCancelResult,
  ContextBuilder,
  DynamicWorkflowRunProgressPayload,
  PermissionBrokerRequest,
  SavedWorkflowScope,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionGoal,
  SessionId,
  SessionProjection,
  SkillLoadOutcome,
  TargetChangedPayload,
  ToolCall,
  ToolCallId,
  ToolExecutor,
  ToolRegistry,
  ToolSchedule,
  TraceContext,
  TurnInputIntentMetadata,
  TurnState,
  UserInputAutoResolutionUpdatedPayload,
} from "./deps.js";

import type { StartSavedWorkflowRunResult } from "./methods/dynamic-workflow-run-start.js";

import type {
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
} from "./methods/dynamic-workflow-run-settings.js";

import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./methods/background.js";

import { type DynamicWorkflowActivationSource } from "./methods/dynamic-workflow-activation.js";

import type {
  ContinueActiveTargetLoopOptions,
  ExecuteToolsOptions,
  ExecuteToolsResult,
  ExecuteTurnOptions,
  PermissionDecisionResult,
  ResumeSessionOptions,
  ResumeSessionResult,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  TurnResult,
} from "./types.js";

import type { ChildClientPortsContext, ClientFacingPorts } from "./helpers/child-client-ports.js";

export interface AgentRuntimeExecutionApi {
  getToolRegistry(): ToolRegistry;

  /**
   * 注册表被外部改写后让 getTools 重算。公开它的唯一使用者是 dwf driver 的 submit profile 运行时
   * 守卫：静态 profile 与实际 ask 不符时把
   * typed 的 submit_result 换回通用声明——改的是同一个注册表，缓存不失效就会继续把旧声明发给模型。
   */
  invalidateToolCache(): void;

  getToolExecutor(): ToolExecutor;

  subscribeEvents(sink: SessionEventSink): () => void;

  /** Bootstrap-owned lifecycle producers append only validated session events through this durable path. */
  appendEvent(event: SessionEvent, traceContext: TraceContext): Promise<void>;

  /**
   * 外部子 runtime 的接缝（一）：交出本 runtime 的会话事件 store，供 class 外构造的子
   * runtime 共享（照 `subagent.ts` 的 `eventStore: this.eventStore`）。理由见
   * `methods/config.ts` 的实现注释。
   */
  getSessionEventStore(): SessionEventStorePort;

  /**
   * 外部子 runtime 的接缝（二）：把子会话的原始事件扇出给本 runtime 的外部 sink 集
   * （保留子 sessionId、只通知不 append）。**必须在子 runtime 构造期装成它的
   * `deps.eventSink`**——理由见 `methods/config.ts` 的实现注释。
   */
  notifyExternalChildSessionEvent(input: {
    childSessionId: SessionId;
    event: SessionEvent;
    traceContext?: TraceContext;
    /**
     * 子 runtime 的交互归属（与 `createChildClientPorts` 同一份）。在场时交互事件
     * （PermissionRequested / Resolved / Denied）另镜像一份到本会话，确认窗才能在父界面出现。
     */
    interactionOrigin?: ChildClientPortsContext;
  }): Promise<void>;

  /**
   * 外部子 runtime 的接缝（三）：铸造子 runtime 的对外交互端口（permission broker +
   * provider runtime headers），已绑定本 runtime 的客户端路由身份。class 外构造的子 runtime
   * **必须**经这里取这两个端口，不能自行从 appOptions 取——理由见 `methods/config.ts` 的实现注释。
   */
  createChildClientPorts(context: ChildClientPortsContext): ClientFacingPorts;

  getContextBuilder(): ContextBuilder;

  /** Composer 使用的 Session Skill 快照；同一 runtime 冻结，runtime 重建后重新发现。 */
  getSkillCatalog(traceContext: TraceContext): Promise<SkillLoadOutcome>;

  resumeFromStore(options?: ResumeSessionOptions): Promise<ResumeSessionResult>;

  recordTargetChanged(input: TargetChangedPayload & { traceContext: TraceContext }): Promise<void>;

  recordUserInputAutoResolutionUpdate(
    input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
  ): Promise<void>;

  /** workflow run 进度的出回合追加（事件源在 bootstrap 的 run service）。 */
  recordDynamicWorkflowRunProgress(
    input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
  ): Promise<void>;

  /** 恢复的 dwf run 的追踪重臂（registry 登记 + started 事件 + waiter + 结算通知）。 */
  /**
   * onDemand 会话注册十个工作流工具（docs/dynamic-workflow/launch.md「On demand: activation」）。
   * 已激活时 no-op 返回 false。触发点：`/workflow` 展开、GUI 的 Resume / 配置 / 直接启动、冷恢复。
   */
  activateDynamicWorkflowTools(input: {
    source: DynamicWorkflowActivationSource;
    traceContext?: TraceContext;
  }): Promise<boolean>;

  trackResumedDynamicWorkflowRun(input: {
    runId: string;
    toolCallId?: string;
    name?: string;
    traceContext?: TraceContext;
  }): Promise<void>;

  /**
   * 中枢直接启动一个已保存的工作流：解析 + 校验 + 编译，
   * 干净则 submit 启动 run、落 controlOnly 启动轮、登记后台追踪。`app.startSavedWorkflow` 能力的
   * 落地实现（端口在场时注册）。
   */
  startSavedWorkflowRun(input: {
    name: string;
    scope?: SavedWorkflowScope;
    args?: Record<string, unknown>;
    traceContext?: TraceContext;
  }): Promise<StartSavedWorkflowRunResult>;

  /**
   * GUI「配置」改一个 run 的子代理模型与并发上界：以同一份脚本修订出新 run、登记后台追踪、把设置轮排进队列。
   * `app.amendWorkflowRunSettings` 能力的落地实现。
   */
  amendWorkflowRunSettings(
    input: AmendWorkflowRunSettingsInput,
  ): Promise<AmendWorkflowRunSettingsResult>;

  recordGoalStateChangeReminder(input: {
    text: string;
    traceContext?: TraceContext;
  }): Promise<void>;

  continueActiveTargetIfIdle(options?: {
    abortSignal?: AbortSignal;
    inputId?: string;
    intent?: TurnInputIntentMetadata;
    traceContext?: TraceContext;
    verifyBeforeContinue?: boolean;
  }): Promise<TurnResult | null>;

  continueActiveTargetLoop(options: ContinueActiveTargetLoopOptions): Promise<TurnResult | null>;

  stopActiveForegroundExecution(
    options?: StopActiveForegroundExecutionOptions,
  ): StopActiveForegroundExecutionResult;

  activatePausedTargetAfterResume(traceContext: TraceContext): Promise<SessionGoal | null>;

  executeTurn(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
  ): Promise<TurnResult>;

  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;

  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;

  emitPermissionRequest(toolCallId: ToolCallId, toolName: string, riskLevel: string): Promise<void>;

  resolvePermission(toolCallId: ToolCallId, decision: PermissionDecisionResult): Promise<void>;

  getPendingPermissionRequests(): PermissionBrokerRequest[];

  getProjection(): Promise<SessionProjection>;

  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;

  cancelBackgroundTask(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;

  stopBackgroundTask(
    taskId: string,
    options: RuntimeBackgroundStopOptions,
  ): Promise<RuntimeBackgroundStopResult>;

  cancelRunningRuntimeBackgroundTasks(input: {
    reason: "subagent_cancelled";
    traceContext?: TraceContext;
  }): Promise<void>;

  sealBackgroundTaskNotifications(input: {
    reason: "subagent_terminal" | "subagent_cancelled";
    traceContext?: TraceContext;
  }): void;

  getSessionId(): SessionId;
}
