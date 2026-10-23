import type { BackgroundBashOutputResult } from "@zcode/shared";

import type {
  BackgroundTaskCancelResult,
  MessageId,
  PermissionBrokerRequest,
  SessionEvent,
  SessionId,
  SessionProjection,
  ToolCall,
  ToolCallId,
  ToolExecutionResult,
  ToolSchedule,
  TraceContext,
} from "./deps.js";

import type { ExecuteToolsOptions, ExecuteToolsResult, PermissionDecisionResult } from "./types.js";

import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./methods/background.js";

export interface InternalTurnToolMethods {
  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;

  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;

  emitToolScheduledEvents(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    assistantMessageId: MessageId,
    traceContext: TraceContext,
  ): Promise<SessionEvent[]>;

  emitFileMutationCheckpoint(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    messageId: MessageId;
    result: ToolExecutionResult;
    toolMessageId?: MessageId;
    traceContext: TraceContext;
  }): Promise<void>;

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

  hasRunningBackgroundTasks(): boolean;

  getSessionId(): SessionId;
}
