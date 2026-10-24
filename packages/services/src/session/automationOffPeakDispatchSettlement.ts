import type { OffPeakTaskRepo } from "./offPeakTaskRepo.js";
import type { ZCodeOffPeakTask } from "@zcode/shared";
import type {
  AutomationDiagnostic,
  SchedulerToMainMessage,
  MainToSchedulerMessage,
} from "./automationSchedulerProtocol.js";

export const OFF_PEAK_DISPATCH_RETRY_BASE_MS = 30_000;
export const OFF_PEAK_DISPATCH_RETRY_CAP_MS = 15 * 60_000;

type OffPeakDispatchResult = Extract<MainToSchedulerMessage, { type: "offpeak-dispatch-result" }>;

type OffPeakDispatchSettlementRepo = Pick<
  OffPeakTaskRepo,
  "markRunning" | "markTerminal" | "releaseClaim"
>;

export interface OffPeakDispatchSettlementDeps {
  repo: OffPeakDispatchSettlementRepo;
  retryAt: Map<string, number>;
  retryAttempts: Map<string, number>;
  now: () => number;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * 闲时任务派发结果结算。
 *
 * 不能忽略 failureKind：缺模型/凭证等确定性配置错误若也无限退避，
 * 导致任务永久显示等待算力并反复消耗服务端 ticket。只有 transient 才允许回 queued。
 */
export async function settleOffPeakDispatchResult(
  deps: OffPeakDispatchSettlementDeps,
  msg: OffPeakDispatchResult,
): Promise<void> {
  const now = deps.now();
  if (msg.ok) {
    deps.retryAt.delete(msg.offPeakTaskId);
    deps.retryAttempts.delete(msg.offPeakTaskId);
    // Host 在放行 CLI 生命周期通知前已落 running；迟到 ACK 不得覆写新票等待或接管状态。
    if (msg.lifecycleManaged) return;
    const updated = await deps.repo.markRunning(msg.offPeakTaskId, {
      startedAt: now,
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
    });
    if (!updated) {
      await deps.repo.releaseClaim(msg.offPeakTaskId, { now });
      deps.log(
        "warn",
        `off-peak dispatch result dropped (task no longer queued) task=${msg.offPeakTaskId}`,
      );
    }
    return;
  }

  const error = msg.error ?? "dispatch failed";
  if (msg.failureKind === "permanent") {
    deps.retryAt.delete(msg.offPeakTaskId);
    deps.retryAttempts.delete(msg.offPeakTaskId);
    const failed = await deps.repo.markTerminal(msg.offPeakTaskId, {
      status: "failed",
      endedAt: now,
      failureReason: error,
      dispatchError: error,
    });
    if (!failed) {
      await deps.repo.releaseClaim(msg.offPeakTaskId, { now });
      deps.log(
        "warn",
        `off-peak permanent dispatch result dropped (task already changed) task=${msg.offPeakTaskId}`,
      );
      return;
    }
    deps.log("warn", `off-peak dispatch permanently failed task=${msg.offPeakTaskId}: ${error}`);
    return;
  }

  const attempts = (deps.retryAttempts.get(msg.offPeakTaskId) ?? 0) + 1;
  deps.retryAttempts.set(msg.offPeakTaskId, attempts);
  const backoff = Math.min(
    OFF_PEAK_DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    OFF_PEAK_DISPATCH_RETRY_CAP_MS,
  );
  deps.retryAt.set(msg.offPeakTaskId, now + backoff);
  await deps.repo.releaseClaim(msg.offPeakTaskId, { error, now });
  deps.log(
    "warn",
    `off-peak dispatch failed task=${msg.offPeakTaskId} attempts=${attempts} retryIn=${backoff}ms: ${error}`,
  );
}

interface OffPeakClaimDispatchDeps {
  repo: Pick<OffPeakTaskRepo, "releaseClaim">;
  retryAt: Map<string, number>;
  inFlight: Set<string>;
  postMessage(message: SchedulerToMainMessage): void;
  log(level: "info" | "warn" | "error", message: string, diagnostic: AutomationDiagnostic): void;
}
/** The off-peak owner dispatches and settles its claims; scheduler owns the shared tick. */
export async function dispatchClaimedOffPeakTask(
  deps: OffPeakClaimDispatchDeps,
  task: ZCodeOffPeakTask,
  now: number,
): Promise<void> {
  const retryAt = deps.retryAt.get(task.offPeakTaskId) ?? 0;
  if (retryAt > now) {
    await deps.repo.releaseClaim(task.offPeakTaskId, { now });
    return;
  }
  if (!task.modelSelection) {
    await deps.repo.releaseClaim(task.offPeakTaskId, { now });
    deps.log(
      "warn",
      `off-peak task claimed without model selection, released task=${task.offPeakTaskId}`,
      {
        event: "automation.offpeak.dispatch",
        outcome: "skipped",
        reason: "model_selection_missing",
        offPeakTaskId: task.offPeakTaskId,
      },
    );
    return;
  }
  deps.inFlight.add(task.offPeakTaskId);
  const request: SchedulerToMainMessage = {
    type: "offpeak-dispatch-request",
    offPeakTaskId: task.offPeakTaskId,
    prompt: task.prompt,
    permissionMode: task.permissionMode,
    // claimDue 已校验模型选择；保留认领 owner 的唯一裁决，不另选默认模型。
    modelSelection: task.modelSelection,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.serverTicketId ? { serverTicketId: task.serverTicketId } : {}),
    projectId: task.projectId,
    hostId: task.hostId,
    additionalDirectories: task.additionalDirectories,
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
  };
  deps.postMessage(request);
  deps.log("info", `off-peak dispatch requested task=${task.offPeakTaskId}`, {
    event: "automation.offpeak.dispatch",
    outcome: "started",
    offPeakTaskId: task.offPeakTaskId,
  });
}
