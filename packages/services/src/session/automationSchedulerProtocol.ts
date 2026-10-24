// 原生 scheduler 与宿主的控制消息；Electron 和普通 Node 适配同一合同。
// 与 host↔main 的 CronRun/CronRunResult(见 @zcode/shared channels + validation)不同：
// 这层是 main 与「常驻 cron scheduler 进程」之间的私有通道；main 收到派发请求后再翻译成 CronRun 转发给 host。
import type { ModelSelection, NodeSelfResourceSample } from "@zcode/shared";

/** Structured native facts only: never include prompts, paths or raw exceptions. */
export interface AutomationDiagnostic {
  event:
    | "automation.claim.renew"
    | "automation.claim.release"
    | "automation.outcome.write"
    | "automation.dispatch.write"
    | "automation.unread.write"
    | "automation.delivery.subscribe"
    | "automation.scheduler.tick"
    | "automation.scheduler.misfire"
    | "automation.scheduler.wake"
    | "automation.scheduler.recovery"
    | "automation.scheduler.started"
    | "automation.offpeak.dispatch"
    | "automation.offpeak.settlement"
    | "automation.offpeak.count";
  outcome: "failed" | "succeeded" | "skipped" | "started";
  reason?:
    | "native_write_failed"
    | "native_dispatch_failed"
    | "claim_context_missing"
    | "missed_window"
    | "task_changed"
    | "model_selection_missing";
  runId?: string;
  automationId?: string;
  offPeakTaskId?: string;
  correlationId?: string;
}

/** scheduler → main */
export type SchedulerToMainMessage =
  | {
      type: "cron-dispatch-request";
      automationId: string;
      runId: string;
      prompt: string;
      targetTaskId?: string;
      modelSelection?: ModelSelection;
      mode?: string;
      workspacePath: string;
      workspaceIdentity?: string;
      projectId?: string | null;
      hostId?: string;
      additionalDirectories?: string[];
    }
  | {
      // 闲时任务派发：与 cron 消息对独立。首跑不带 conversationId/sessionId，
      // host createTask 新建 session；续跑/中断恢复带上两者 resume 同一会话。
      type: "offpeak-dispatch-request";
      offPeakTaskId: string;
      prompt: string;
      permissionMode: string;
      modelSelection: ModelSelection;
      conversationId?: string;
      sessionId?: string;
      serverTicketId?: string;
      workspacePath: string;
      workspaceIdentity?: string;
      projectId?: string | null;
      hostId?: string;
      additionalDirectories?: string[];
    }
  | {
      type: "scheduler-log";
      level: "info" | "warn" | "error";
      message: string;
      diagnostic?: AutomationDiagnostic;
    }
  | {
      // 闲时任务 running 计数变化 → main 据此 + keepAwakeWhileRunning 设置
      // 决定是否开 powerSaveBlocker。每次 tick 后上报当前值（幂等）。
      type: "offpeak-active-count";
      count: number;
    }
  | {
      // scheduler 进程每 60 秒的自采样本。
      // main 只取其中的 heap 作 scheduler 角色事件的 heap 维度，CPU 与 RSS 仍以 getAppMetrics 为准。
      type: "scheduler-resource-sample";
      sample: NodeSelfResourceSample;
    };

/** main → scheduler */
export type MainToSchedulerMessage =
  | {
      type: "cron-dispatch-result";
      runId: string;
      ok: boolean;
      taskId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }
  | {
      // 闲时任务派发结果；迟到结果仅凭 offPeakTaskId 结算（无 inFlight 上下文也可，幂等）。
      type: "offpeak-dispatch-result";
      offPeakTaskId: string;
      ok: boolean;
      lifecycleManaged?: true;
      conversationId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }
  | {
      // main 在退出前通知 scheduler 优雅收尾（释放认领、关库）。
      type: "scheduler-dispose";
    }
  | {
      // manual run 已提交，立即触发一次 tick；automationId 仅用于日志关联。
      type: "scheduler-wake";
      automationId: string;
    };
