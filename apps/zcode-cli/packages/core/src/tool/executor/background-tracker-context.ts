import type { ToolExecutorDeps } from "./types.js";
import type { SessionEvent } from "@zcode/contracts";
import type { TraceContext } from "@zcode/contracts";
import type { TurnId } from "@zcode/contracts";
import type { ExecutableToolCall } from "../types.js";
import type { BackgroundTaskSnapshot } from "./background-task-contract.js";
import type { BackgroundTaskLifecycleProvider } from "./background-task-contract.js";

/** 同一 owner 的唯一内部状态 / 协作形状；不从实现类反向取型。 */
export interface BackgroundTaskTrackerContext {
  readonly backgroundPollers: Set<string>;
  backgroundSnapshotSignature(snapshot: BackgroundTaskSnapshot): string;
  backgroundTaskPayload(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot?: BackgroundTaskSnapshot,
    output?: Record<string, unknown>,
  ): Record<string, unknown>;
  canCancelBackgroundTask(toolCall: ExecutableToolCall): boolean;
  readonly deps: ToolExecutorDeps;
  emitBackgroundTaskEvent(
    type: SessionEvent["type"],
    payload: Record<string, unknown>,
    traceContext: TraceContext,
    turnId: TurnId | undefined,
  ): Promise<void>;
  formatBackgroundTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    output?: Record<string, unknown>,
  ): string | undefined;
  formatWorkflowTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    launchOutput?: Record<string, unknown>,
  ): string;
  getBackgroundTaskSnapshot(
    toolCall: ExecutableToolCall,
    taskId: string,
  ): Promise<BackgroundTaskSnapshot | undefined>;
  hasBackgroundTaskSnapshotProvider(toolCall: ExecutableToolCall): boolean;
  hasDirectBackgroundTaskWaiter(toolCall: ExecutableToolCall): boolean;
  isNotifiedLocalAgentSnapshot(
    toolCall: ExecutableToolCall,
    snapshot: BackgroundTaskSnapshot,
  ): boolean;
  lifecycleProvider(toolCall: ExecutableToolCall): BackgroundTaskLifecycleProvider;
  maybeEnqueueBackgroundTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    traceContext: TraceContext,
    output?: Record<string, unknown>,
  ): void;
  trackBackgroundTask(
    toolCall: ExecutableToolCall,
    output: unknown,
    traceContext: TraceContext,
    turnId: TurnId | undefined,
  ): Promise<void>;
  waitForBackgroundTaskSnapshot(
    toolCall: ExecutableToolCall,
    taskId: string,
  ): Promise<BackgroundTaskSnapshot | undefined>;
}
