import {
  type DynamicWorkflowRunSnapshot,
  type ExecutionPort,
  type SubagentTaskSnapshot,
  type WorkflowTaskSnapshot,
} from "@zcode/contracts";

// ⚠ 两个 artifact：上面那个是脚本的**顶层返回值**（引擎内部的 `RunSettlement.artifact`，进
// `<result>`），下面这个是脚本经 `artifact.*` **发布给用户看的产出**（进 `<artifacts>`）。
// 两者在同一条完成通知里并列出现，所以模块也分开。

export type BackgroundTaskSnapshot =
  | NonNullable<Awaited<ReturnType<NonNullable<ExecutionPort["getBackgroundTask"]>>>>
  | SubagentTaskSnapshot
  | WorkflowTaskSnapshot
  // workflow run 的快照沿用 WorkflowTaskSnapshot 的形状但把 output 放宽成 unknown（产物由脚本
  // 的顶层返回值决定），所以它不是 WorkflowTaskSnapshot 的子类型，必须单列一支。
  | DynamicWorkflowRunSnapshot;

export type BackgroundTaskWaiter = {
  waitForBackgroundTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundTaskSnapshot | undefined>;
};

export type WorkflowTaskWaiter = {
  waitForTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundTaskSnapshot | undefined>;
};

/**
 * 一个工具的后台生命周期提供者。这五件事若按工具名散在五处 `if (toolCall.name === …)`，
 * 每接一个后台工具就要记得同时改齐五处——`canCancelBackgroundTask` 对 legacy `Workflow`
 * 硬返回 false 就会是漏改的现场：它让 started payload 的 cancellable 恒假，取消入口直接死掉。
 * 按工具名查一次表拿到这个结构，五处分派退化成读它的字段。
 *
 * 缺省语义（字段缺席）与泛化前逐字一致：无 getSnapshot → 无快照提供者（不起 1s 轮询）；
 * 无 waitForTerminal → 无直接等待者；cancellable 缺省 false。
 */
export interface BackgroundTaskLifecycleProvider {
  /** 1s 轮询的快照源。 */
  getSnapshot?: (taskId: string) => Promise<BackgroundTaskSnapshot | undefined>;
  /** 终态直接等待者（比轮询更及时，且轮询源缺席时是唯一终态来源）。 */
  waitForTerminal?: (taskId: string) => Promise<BackgroundTaskSnapshot | undefined>;
  /** 运行中的任务是否可被用户取消；决定 started/updated payload 的 `cancellable`。 */
  cancellable?: boolean;
}
