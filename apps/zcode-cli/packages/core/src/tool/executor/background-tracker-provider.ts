import { isSubagentDispatchToolName } from "../compat.js";

import type { ExecutableToolCall } from "../types.js";

import { isDynamicWorkflowRunDispatchToolName } from "./background-task-registry.js";

// ⚠ 两个 artifact：上面那个是脚本的**顶层返回值**（引擎内部的 `RunSettlement.artifact`，进
// `<result>`），下面这个是脚本经 `artifact.*` **发布给用户看的产出**（进 `<artifacts>`）。
// 两者在同一条完成通知里并列出现，所以模块也分开。

import { getBackgroundTaskWaiter, getWorkflowTaskWaiter } from "./background-task-outcomes.js";

import type {
  BackgroundTaskLifecycleProvider,
  BackgroundTaskSnapshot,
} from "./background-task-contract.js";
import type { BackgroundTaskTrackerContext } from "./background-tracker-context.js";
export function hasBackgroundTaskSnapshotProvider(
  this: BackgroundTaskTrackerContext,
  toolCall: ExecutableToolCall,
): boolean {
  return this.lifecycleProvider(toolCall).getSnapshot !== undefined;
}

export function hasDirectBackgroundTaskWaiter(
  this: BackgroundTaskTrackerContext,
  toolCall: ExecutableToolCall,
): boolean {
  return this.lifecycleProvider(toolCall).waitForTerminal !== undefined;
}

export async function waitForBackgroundTaskSnapshot(
  this: BackgroundTaskTrackerContext,
  toolCall: ExecutableToolCall,
  taskId: string,
): Promise<BackgroundTaskSnapshot | undefined> {
  return this.lifecycleProvider(toolCall).waitForTerminal?.(taskId);
}

export async function getBackgroundTaskSnapshot(
  this: BackgroundTaskTrackerContext,
  toolCall: ExecutableToolCall,
  taskId: string,
): Promise<BackgroundTaskSnapshot | undefined> {
  return this.lifecycleProvider(toolCall).getSnapshot?.(taskId);
}

/**
 * 按工具名解析后台生命周期提供者。每个分支只描述"这个工具的四件事分别由哪个端口承担"，
 * 与泛化前的五处 if 一一对应，语义逐字保持。
 */

export function lifecycleProvider(
  this: BackgroundTaskTrackerContext,
  toolCall: ExecutableToolCall,
): BackgroundTaskLifecycleProvider {
  const deps = this.deps;

  if (isSubagentDispatchToolName(toolCall.name)) {
    const getTask = deps.subagentPort?.getTask;
    return {
      ...(getTask
        ? { getSnapshot: (taskId: string) => getTask.call(deps.subagentPort, taskId) }
        : {}),
      // 修复原因：background Agent 的停止入口在 subagentPort.stopTask；
      // started payload 不能沿用 Bash 的 executionPort 能力判断。
      cancellable: Boolean(deps.subagentPort?.stopTask),
    };
  }

  if (isDynamicWorkflowRunDispatchToolName(toolCall.name)) {
    // workflow run：快照/等待/取消全部来自窄端口 DynamicWorkflowRunPort（runId ≡ taskId ≡ workId）。
    // 取消能力以 cancel 方法存在为准，而不是硬编码——端口在场即可取消，这正是详情页
    // Cancel 按钮与后台面板停止共用的那条唯一路径的前提。CreateWorkflow（新启动）与
    // ResumeWorkflowRun（恢复）共用同一 provider：registry 条目重臂时经 existing 合并
    // 语义沿用原始工具行的 parentToolCallId，两条入口对 tracker 完全同构。
    const port = deps.dynamicWorkflowRunPort;
    if (port === undefined) return {};
    return {
      getSnapshot: (taskId: string) => port.getTask(taskId),
      ...(typeof port.waitForTask === "function"
        ? { waitForTerminal: (taskId: string) => port.waitForTask(taskId) }
        : {}),
      cancellable: typeof port.cancel === "function",
    };
  }

  if (toolCall.name === "Workflow") {
    // legacy Workflow：只有快照与等待，没有取消——停止入口从未接过（保持泛化前的 false）。
    const getTask = deps.workflowPort?.getTask;
    const waiter = getWorkflowTaskWaiter(deps.workflowPort);
    return {
      ...(getTask
        ? { getSnapshot: (taskId: string) => getTask.call(deps.workflowPort, taskId) }
        : {}),
      ...(waiter ? { waitForTerminal: (taskId: string) => waiter.waitForTask(taskId) } : {}),
      cancellable: false,
    };
  }

  if (toolCall.name === "Bash") {
    const waiter = getBackgroundTaskWaiter(deps.executionPort);
    const getBackgroundTask = deps.executionPort?.getBackgroundTask;
    return {
      ...(getBackgroundTask
        ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
        : {}),
      ...(waiter
        ? { waitForTerminal: (taskId: string) => waiter.waitForBackgroundTask(taskId) }
        : {}),
      cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
    };
  }

  // 其余工具沿用 executionPort 的通用后台面（无直接等待者），与泛化前一致。
  const getBackgroundTask = deps.executionPort?.getBackgroundTask;
  return {
    ...(getBackgroundTask
      ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
      : {}),
    cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
  };
}
