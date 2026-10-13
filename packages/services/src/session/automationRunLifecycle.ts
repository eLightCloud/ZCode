import type { ZCodeAutomationRunOutcome, ZCodeAutomationTrigger } from "@zcode/shared";
import { computeAutomationNextRunAt } from "./automationCron.js";
import { settleManualClaimForDispatchResult } from "./automationManualClaimRelease.js";
import type { AutomationRepo } from "./automationRepo.js";
import type {
  MainToSchedulerMessage,
  AutomationDiagnostic,
} from "./automationSchedulerProtocol.js";

export interface CronRunLifecycleRepo {
  ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): Promise<void>;
  markRunOutcome(runId: string, outcome: ZCodeAutomationRunOutcome, error?: string): Promise<void>;
  markRunDispatch(params: {
    runId: string;
    dispatchStatus: "failed_to_dispatch";
    error: string;
  }): Promise<void>;
  touchManualClaim(automationId: string, workspaceKey: string): Promise<void>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

export interface CronRunLifecycleIdentity {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: ZCodeAutomationTrigger;
}

type LogWarn = (message: string, error: unknown, diagnostic?: AutomationDiagnostic) => void;

const MANUAL_CLAIM_HEARTBEAT_MS = 60_000;

export function startManualClaimHeartbeat(
  params: Pick<CronRunLifecycleIdentity, "automationId" | "runId" | "workspaceKey"> & {
    repo: Pick<CronRunLifecycleRepo, "touchManualClaim">;
    logWarn: LogWarn;
    intervalMs?: number;
  },
): { dispose(): void } {
  const timer = setInterval(() => {
    void params.repo.touchManualClaim(params.automationId, params.workspaceKey).catch((error) =>
      params.logWarn(
        `续租 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
        error,
        {
          event: "automation.claim.renew",
          outcome: "failed",
          reason: "native_write_failed",
          runId: params.runId,
          automationId: params.automationId,
        },
      ),
    );
  }, params.intervalMs ?? MANUAL_CLAIM_HEARTBEAT_MS);
  return { dispose: () => clearInterval(timer) };
}

export async function recordCronRunOutcomeBestEffort(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    outcome: ZCodeAutomationRunOutcome;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    await params.repo.ensureRunClaimed(params);
    await params.repo.markRunOutcome(params.runId, params.outcome, params.error);
  } catch (error) {
    params.logWarn(
      `回写定时任务运行结果失败 automation=${params.automationId} runId=${params.runId}`,
      error,
      {
        event: "automation.outcome.write",
        outcome: "failed",
        reason: "native_write_failed",
        runId: params.runId,
        automationId: params.automationId,
      },
    );
  }
}

export async function releaseManualClaimBestEffort(
  params: Pick<CronRunLifecycleIdentity, "automationId" | "runId" | "workspaceKey"> & {
    repo: Pick<CronRunLifecycleRepo, "releaseManualClaim">;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    await params.repo.releaseManualClaim(params.automationId, params.workspaceKey);
  } catch (error) {
    params.logWarn(
      `释放 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
      error,
      {
        event: "automation.claim.release",
        outcome: "failed",
        reason: "native_write_failed",
        runId: params.runId,
        automationId: params.automationId,
      },
    );
  }
}

/** 派发失败清理永不覆盖调用方持有的原始 dispatch error。 */
export async function settleManualDispatchFailureBestEffort(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    dispatchError: unknown;
    logWarn: LogWarn;
  },
): Promise<void> {
  const errorMessage =
    params.dispatchError instanceof Error
      ? params.dispatchError.message
      : String(params.dispatchError);
  try {
    await params.repo.markRunDispatch({
      runId: params.runId,
      dispatchStatus: "failed_to_dispatch",
      error: errorMessage,
    });
  } catch (error) {
    params.logWarn(
      `回写 manual automation 派发失败状态失败 automation=${params.automationId} runId=${params.runId}`,
      error,
      {
        event: "automation.dispatch.write",
        outcome: "failed",
        reason: "native_write_failed",
        runId: params.runId,
        automationId: params.automationId,
      },
    );
  }
  await releaseManualClaimBestEffort(params);
}

/** manual claim 覆盖 queue 等待和 turn 执行，只能在真实终态后释放。 */
export async function settleCronRunTerminalOutcome(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    outcome: Exclude<ZCodeAutomationRunOutcome, "running">;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  await recordCronRunOutcomeBestEffort(params);
  if (params.trigger !== "manual") return;
  await releaseManualClaimBestEffort(params);
}

export interface SchedulerDispatchContext {
  automationId: string;
  workspaceKey: string;
  trigger: ZCodeAutomationTrigger;
}
/** Native lifecycle owner settles admissions; scheduler retains the single polling/claim loop. */
export async function settleSchedulerDispatchResult(
  deps: {
    repo: AutomationRepo;
    inFlight: Map<string, SchedulerDispatchContext>;
    log(level: "info" | "warn" | "error", message: string, diagnostic: AutomationDiagnostic): void;
  },
  msg: Extract<MainToSchedulerMessage, { type: "cron-dispatch-result" }>,
): Promise<void> {
  const { repo, inFlight, log } = deps;
  const context = inFlight.get(msg.runId);
  inFlight.delete(msg.runId);
  const now = Date.now();
  // 从 runId 还原 automationId（context 丢失时兜底，如 scheduler 重启后收到迟到回报）。
  const automationId = context?.automationId ?? msg.runId.split(":")[0]!;
  const workspaceKey = context?.workspaceKey;
  const trigger: ZCodeAutomationTrigger =
    context?.trigger ?? (msg.runId.includes(":manual:") ? "manual" : "schedule");
  const settleManualClaim = async (ok: boolean): Promise<void> => {
    await settleManualClaimForDispatchResult({
      repo,
      automationId,
      runId: msg.runId,
      workspaceKey,
      ok,
      logError: (message) =>
        log("error", message, {
          event: "automation.claim.release",
          outcome: "skipped",
          reason: "claim_context_missing",
          runId: msg.runId,
          automationId,
        }),
    });
  };

  if (msg.ok) {
    if (trigger === "manual") {
      await repo.markManualRunDispatched({
        runId: msg.runId,
        sessionId: msg.sessionId ?? null,
        dispatchedAt: now,
      });
      await settleManualClaim(true);
      return;
    }
    await repo.markRunDispatch({
      runId: msg.runId,
      dispatchStatus: "dispatched",
      sessionId: msg.sessionId ?? null,
    });
    const automation = await repo.get(automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, now) : null;
    await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt });
    return;
  }

  await repo.markRunDispatch({
    runId: msg.runId,
    dispatchStatus: "failed_to_dispatch",
    error: msg.error ?? "dispatch failed",
  });
  if (trigger === "manual") {
    await settleManualClaim(false);
    return;
  }
  const kind = msg.failureKind ?? "transient";
  await repo.markDispatchFailed(automationId, {
    failedAt: now,
    error: msg.error ?? "dispatch failed",
    kind,
    // transient 达上限后循环任务跳下一个正常 next_run_at。
    nextRunAt: await repo
      .get(automationId)
      .then((automation) => (automation ? computeAutomationNextRunAt(automation, now) : null)),
  });
}
