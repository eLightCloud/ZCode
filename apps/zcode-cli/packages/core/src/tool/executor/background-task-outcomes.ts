import { type BashTaskNotificationStatus } from "./background-notification-status.js";
export type { BashTaskNotificationStatus } from "./background-notification-status.js";
import { type ExecutionPort } from "@zcode/contracts";

import { isSubagentDispatchToolName } from "../compat.js";

import type { ExecutableToolCall } from "../types.js";

import { isRecord } from "./utils.js";

import { isDynamicWorkflowRunDispatchToolName } from "./background-task-registry.js";

// ⚠ 两个 artifact：上面那个是脚本的**顶层返回值**（引擎内部的 `RunSettlement.artifact`，进
// `<result>`），下面这个是脚本经 `artifact.*` **发布给用户看的产出**（进 `<artifacts>`）。
// 两者在同一条完成通知里并列出现，所以模块也分开。

import type { BackgroundTaskWaiter, WorkflowTaskWaiter } from "./background-task-contract.js";

import { stringField } from "./workflow-task-notifications.js";

export {
  WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS,
  WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS,
  WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS,
  buildWorkflowNotificationOriginMeta,
  buildWorkflowTaskSummary,
  buildWorkflowTerminalNotification,
  nonNegativeFinite,
  runtimeString,
  stringField,
  workflowNotificationDurationMs,
  workflowSnapshotArtifacts,
  workflowSnapshotReportCount,
  workflowSnapshotReports,
  workflowSnapshotScriptPath,
  workflowSnapshotTerminal,
  workflowTaskSubject,
  workflowTerminalNotificationStatus,
} from "./workflow-task-notifications.js";

export type { WorkflowTerminalRunStatus } from "./workflow-task-notifications.js";

export function isBackgroundTaskLaunch(
  toolCall: ExecutableToolCall,
  output: Record<string, unknown>,
): boolean {
  if (output.status === "backgrounded") return true;
  return isSubagentDispatchToolName(toolCall.name) && output.status === "async_launched";
}

export function normalizeBashTaskNotificationStatus(status: string): BashTaskNotificationStatus {
  return normalizeBackgroundTaskNotificationStatus(status);
}

export function normalizeBackgroundTaskNotificationStatus(
  status: string,
): BashTaskNotificationStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
    case "timed_out":
    case "killed":
    case "stopped":
      return "killed";
    default:
      return "failed";
  }
}

export function resolveBashBackgroundResultTitle(
  toolCall: ExecutableToolCall,
  taskId: string,
): string {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const description = stringField(input, "description")?.trim();
  const command = stringField(input, "command")?.trim();
  return description || command || toolCall.name || taskId;
}

export function buildBackgroundTaskSummary(input: {
  command?: string;
  description?: string;
  exitCode?: number;
  lost?: boolean;
  status: BashTaskNotificationStatus;
}): string {
  const subject = input.description ?? input.command ?? "Bash background command";
  const prefix = `Background command "${subject}"`;
  // Provider-visible summary 保持简洁；完整输出路径由 task-notification 的 output-file 字段承载。
  if (input.lost) return `${prefix} failed because its in-process state was lost`;
  switch (input.status) {
    case "completed":
      return `${prefix} completed${input.exitCode !== undefined ? ` (exit code ${input.exitCode})` : ""}`;
    case "failed":
      return `${prefix} failed${input.exitCode !== undefined ? ` with exit code ${input.exitCode}` : ""}`;
    case "killed":
      return `${prefix} was stopped`;
  }
}

export function getBackgroundTaskWaiter(
  executionPort: ExecutionPort | undefined,
): BackgroundTaskWaiter | undefined {
  const candidate = executionPort as Partial<BackgroundTaskWaiter> | undefined;
  return typeof candidate?.waitForBackgroundTask === "function"
    ? (candidate as BackgroundTaskWaiter)
    : undefined;
}

export function getWorkflowTaskWaiter(workflowPort: unknown): WorkflowTaskWaiter | undefined {
  const candidate = workflowPort as Partial<WorkflowTaskWaiter> | undefined;
  return typeof candidate?.waitForTask === "function"
    ? (candidate as WorkflowTaskWaiter)
    : undefined;
}

/**
 * 后台任务的展示类别（面板分组与图标）。`taskKind` 只是装饰：生命周期语义已经由
 * per-tool 的 lifecycleProvider 分派，所以这里的分类改动不会影响观察/等待/取消。
 *
 * legacy `Workflow`（script workflow）刻意仍归 "bash"：它不可取消、面板上也没有详情页，
 * 与 workflow run 是两种不同的东西，共用一个类别会让面板把两者混在一起。
 */
export function backgroundTaskKind(toolName: string): "bash" | "subagent" | "workflow" {
  if (isSubagentDispatchToolName(toolName)) return "subagent";
  // dwf 的两个入口（CreateWorkflow / ResumeWorkflowRun）同归 "workflow"：同一个 run 的
  // 生命周期延续，面板分组与图标不该因入口不同而换类。
  return isDynamicWorkflowRunDispatchToolName(toolName) ? "workflow" : "bash";
}
