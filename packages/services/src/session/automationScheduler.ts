/** Sole native scheduler algorithm. Adapters own transport and termination. */
import { randomUUID } from "node:crypto";
import { AutomationRepo } from "./automationRepo.js";
import { resolveWorkspaceKey, type ZCodeAutomation, type ZCodeAutomationRun } from "@zcode/shared";
import type {
  AutomationDiagnostic,
  MainToSchedulerMessage,
  SchedulerToMainMessage,
} from "./automationSchedulerProtocol.js";
import {
  settleSchedulerDispatchResult,
  type SchedulerDispatchContext,
} from "./automationRunLifecycle.js";
import {
  dispatchClaimedOffPeakTask,
  settleOffPeakDispatchResult,
} from "./automationOffPeakDispatchSettlement.js";
import {
  startSchedulerResourceTelemetry,
  type SchedulerResourceTelemetry,
} from "./automationSchedulerResourceTelemetry.js";

import { computeAutomationNextRunAt, isOneShotAutomation } from "./automationCron.js";
import { OffPeakTaskRepo } from "./offPeakTaskRepo.js";

export interface AutomationSchedulerOptions {
  postMessage(message: SchedulerToMainMessage): void;
  /** Trusted host configuration; omitted on Desktop for the native default. */
  databasePath?: string;
  /** Hosts without an off-peak dispatcher must leave its state untouched. */
  offPeakEnabled?: boolean;
}
export interface AutomationSchedulerHandle {
  ready: Promise<void>;
  acceptMessage(message: MainToSchedulerMessage): void;
  dispose(): Promise<void>;
}
export function startAutomationScheduler(
  options: AutomationSchedulerOptions,
): AutomationSchedulerHandle {
  /** 轮询间隔：cron 最小粒度是分钟，20s 轮询足以按时命中且开销低。 */
  const POLL_INTERVAL_MS = 20_000;
  /**
   * misfire 宽限：next_run_at 早于 now 超过该值，视为「关机/休眠/退出期间错过的窗口」→ 记 skipped 不补跑。
   * 取值需明显大于一次正常轮询延迟（避免把正常到点误判成 misfire），又能覆盖短暂卡顿。
   */
  const MISFIRE_GRACE_MS = 5 * 60_000;

  const repo = new AutomationRepo(options.databasePath);
  /** runId → 在途派发上下文；等 main 回报后结算。scheduler 重启丢失时靠 claimDue 的僵尸回收兜底。 */
  const inFlight = new Map<string, SchedulerDispatchContext>();

  // ---- 闲时任务（off-peak）----
  const offPeakRepo = new OffPeakTaskRepo(options.databasePath);
  /** 进程内退避表：offPeakTaskId → 下次允许派发时间/已失败次数。scheduler 重启即重置，无害。 */
  const offPeakRetryAt = new Map<string, number>();
  const offPeakRetryAttempts = new Map<string, number>();
  /** 在途派发集合：仅用于退出时释放认领；迟到结果凭 offPeakTaskId 即可结算，不依赖它。 */
  const offPeakInFlight = new Set<string>();

  let activeTick: Promise<void> | undefined;
  let ticking = false;
  let tickRequested = false;
  let schedulerReady = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const settlements = new Set<Promise<void>>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 资源遥测：本进程唯一的自采定时器。 */
  let resourceTelemetry: SchedulerResourceTelemetry | null = null;

  function log(
    level: "info" | "warn" | "error",
    message: string,
    diagnostic: AutomationDiagnostic,
  ): void {
    const msg: SchedulerToMainMessage = {
      type: "scheduler-log",
      level,
      message,
      diagnostic: {
        ...diagnostic,
        correlationId: diagnostic.runId ?? diagnostic.correlationId ?? randomUUID(),
      },
    };
    options.postMessage(msg);
  }

  /** 派发时间戳：优先用 next_run_at（重试期间不变，保证 runId 稳定），退到 retry_at / now。 */
  function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
    return automation.nextRunAt ?? automation.retryAt ?? now;
  }

  function buildRunId(automationId: string, scheduledAt: number): string {
    return `${automationId}:${scheduledAt}`;
  }

  async function tick(): Promise<void> {
    if (disposed || !schedulerReady || ticking) return;
    ticking = true;
    try {
      do {
        tickRequested = false;
        try {
          const now = Date.now();
          const claimed = await repo.claimDue(now);
          for (const automation of claimed) {
            await handleClaimed(automation, now);
          }
          const manualRuns = await repo.claimManualRuns(now);
          for (const manualRun of manualRuns) {
            await handleClaimedManual(manualRun.automation, manualRun.run);
          }
          if (options.offPeakEnabled !== false) {
            const offPeakClaimed = await offPeakRepo.claimDue(now);
            for (const task of offPeakClaimed) {
              await dispatchClaimedOffPeakTask(
                {
                  repo: offPeakRepo,
                  retryAt: offPeakRetryAt,
                  inFlight: offPeakInFlight,
                  postMessage: options.postMessage,
                  log,
                },
                task,
                now,
              );
            }
            // keep-awake：只处理当前宿主实际承载的闲时任务。
            await reportOffPeakActiveCount();
          }
        } catch (error) {
          log("error", `tick failed: ${error instanceof Error ? error.message : String(error)}`, {
            event: "automation.scheduler.tick",
            outcome: "failed",
            reason: "native_write_failed",
          });
        }
        // manual run 的唤醒可能与当前 tick 重叠；因 ticking=true 直接丢弃会让
        // 用户仍需等待下一轮 20 秒轮询。记录 pending，并在本轮完成后立即补跑。
      } while (tickRequested && !disposed);
    } finally {
      ticking = false;
    }
  }

  function requestTick(): void {
    if (disposed) return;
    if (!schedulerReady || ticking) {
      tickRequested = true;
      return;
    }
    activeTick = tick();
  }

  async function handleClaimed(automation: ZCodeAutomation, now: number): Promise<void> {
    const scheduledAt = resolveScheduledAt(automation, now);
    const runId = buildRunId(automation.automationId, scheduledAt);
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    });
    const isRetry = automation.dispatchAttempts > 0;

    // misfire：首轮（非重试）且计划触发时间已远早于 now → 认定错过窗口，跳过不补跑。
    const missed =
      !isRetry && automation.nextRunAt != null && automation.nextRunAt <= now - MISFIRE_GRACE_MS;
    if (missed) {
      // 纯一次性任务（如 delayMinutes 落成的 minute scheduleRule）错过窗口后，
      // 通用重算会给出 anchorAt + k*interval 的下一周期，让“只跑一次”的提醒在后续周期
      // 继续执行。一次性语义是确定的目标时刻，错过即终态，不得再排程新的执行承诺。
      const finalize = isOneShotAutomation(automation);
      const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, now);
      await repo.skipAndReschedule({
        automationId: automation.automationId,
        runId,
        workspaceKey,
        scheduledAt,
        reason: "computer_asleep_or_app_not_running",
        nextRunAt,
        finalize,
      });
      log(
        "info",
        `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
        {
          event: "automation.scheduler.misfire",
          outcome: "skipped",
          reason: "missed_window",
          automationId: automation.automationId,
          runId,
        },
      );
      return;
    }

    // 正常派发：先落/更新 run 台账（claimed），再把请求发回 main。
    await repo.upsertRunClaimed({
      runId,
      automationId: automation.automationId,
      workspaceKey,
      scheduledAt,
      trigger: "schedule",
      // 原意图在 dispatch request 中传递，首次有效选择由目标 Host 固定；此处不提前冻结。
    });
    inFlight.set(runId, {
      automationId: automation.automationId,
      workspaceKey,
      trigger: "schedule",
    });
    const run = await repo.getRun(runId);
    postDispatchRequest(automation, runId, run?.modelSelection);
  }

  function postDispatchRequest(
    automation: ZCodeAutomation,
    runId: string,
    fixedSelection?: ZCodeAutomationRun["modelSelection"],
  ): void {
    const request: SchedulerToMainMessage = {
      type: "cron-dispatch-request",
      automationId: automation.automationId,
      runId,
      prompt: automation.prompt,
      projectId: automation.projectId,
      hostId: automation.hostId,
      additionalDirectories: automation.additionalDirectories,
      ...(automation.targetTaskId ? { targetTaskId: automation.targetTaskId } : {}),
      ...((fixedSelection ?? automation.modelSelection)
        ? { modelSelection: fixedSelection ?? automation.modelSelection }
        : {}),
      ...(automation.mode ? { mode: automation.mode } : {}),
      workspacePath: automation.workspacePath,
      ...(automation.workspaceIdentity ? { workspaceIdentity: automation.workspaceIdentity } : {}),
    };
    options.postMessage(request);
  }

  async function handleClaimedManual(
    automation: ZCodeAutomation,
    run: ZCodeAutomationRun,
  ): Promise<void> {
    inFlight.set(run.runId, {
      automationId: automation.automationId,
      workspaceKey: resolveWorkspaceKey({
        workspacePath: automation.workspacePath,
        workspaceIdentity: automation.workspaceIdentity,
      }),
      trigger: "manual",
    });
    postDispatchRequest(automation, run.runId, run.modelSelection);
  }

  /** 执行中计数上报（keep-awake）：仅在值变化时发消息，减噪。 */
  let lastOffPeakActiveCount = -1;
  async function reportOffPeakActiveCount(): Promise<void> {
    try {
      const count = await offPeakRepo.countActive();
      if (count === lastOffPeakActiveCount) return;
      lastOffPeakActiveCount = count;
      const msg: SchedulerToMainMessage = { type: "offpeak-active-count", count };
      options.postMessage(msg);
    } catch (error) {
      log(
        "warn",
        `off-peak active count report failed: ${error instanceof Error ? error.message : String(error)}`,
        { event: "automation.offpeak.count", outcome: "failed", reason: "native_write_failed" },
      );
    }
  }

  function dispose(): Promise<void> {
    return (disposal ??= disposeOnce());
  }

  async function disposeOnce(): Promise<void> {
    disposed = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    resourceTelemetry?.stop();
    resourceTelemetry = null;
    await ready.catch(() => {});
    await activeTick;
    // 已接收回执的写事务先完成，不能关库后让其重新打开连接。
    await Promise.allSettled(settlements);
    // 释放本进程仍在途的认领，避免下次启动等到 CLAIM_STALE 才回收。
    for (const [, context] of inFlight) {
      try {
        if (context.trigger === "manual") {
          await repo.releaseManualClaim(context.automationId, context.workspaceKey);
        } else {
          await repo.releaseClaim(context.automationId);
        }
      } catch {
        // 忽略：退出路径尽力而为。
      }
    }
    inFlight.clear();
    for (const offPeakTaskId of offPeakInFlight) {
      try {
        await offPeakRepo.releaseClaim(offPeakTaskId);
      } catch {
        // 忽略：退出路径尽力而为。
      }
    }
    offPeakInFlight.clear();
    try {
      repo.close();
    } catch {
      // 忽略。
    }
    try {
      offPeakRepo.close();
    } catch {
      // 忽略。
    }
  }

  function settle(work: Promise<void>): void {
    settlements.add(work);
    void work.then(
      () => settlements.delete(work),
      () => settlements.delete(work),
    );
  }

  function acceptMessage(msg: MainToSchedulerMessage): void {
    if (disposed) return;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "scheduler-dispose") {
      void dispose();
      return;
    }
    if (msg.type === "cron-dispatch-result") {
      settle(
        settleSchedulerDispatchResult({ repo, inFlight, log }, msg)
          .then(() => {
            // manual run 可能因同一 automation 已有派发在途而暂时无法认领。
            // 前一轮结算释放 single-flight 锁后主动 tick，避免再次等待 20 秒轮询。
            requestTick();
          })
          .catch((error) => {
            log(
              "error",
              `settle dispatch result failed runId=${msg.runId}: ${error instanceof Error ? error.message : String(error)}`,
              {
                event: "automation.dispatch.write",
                outcome: "failed",
                reason: "native_write_failed",
                runId: msg.runId,
              },
            );
          }),
      );
      return;
    }
    if (msg.type === "offpeak-dispatch-result") {
      offPeakInFlight.delete(msg.offPeakTaskId);
      settle(
        settleOffPeakDispatchResult(
          {
            repo: offPeakRepo,
            retryAt: offPeakRetryAt,
            retryAttempts: offPeakRetryAttempts,
            now: Date.now,
            log: (level, message) =>
              log(level, message, {
                event: "automation.offpeak.settlement",
                outcome: msg.ok ? "skipped" : "failed",
                reason: msg.ok ? "task_changed" : "native_dispatch_failed",
                offPeakTaskId: msg.offPeakTaskId,
              }),
          },
          msg,
        ).catch((error) => {
          log(
            "error",
            `settle off-peak dispatch result failed task=${msg.offPeakTaskId}: ${error instanceof Error ? error.message : String(error)}`,
            {
              event: "automation.offpeak.settlement",
              outcome: "failed",
              reason: "native_write_failed",
              offPeakTaskId: msg.offPeakTaskId,
            },
          );
        }),
      );
      return;
    }
    if (msg.type === "scheduler-wake") {
      log("info", `manual run wake requested automation=${msg.automationId}`, {
        event: "automation.scheduler.wake",
        outcome: "started",
        automationId: msg.automationId,
      });
      requestTick();
    }
  }

  async function main(): Promise<void> {
    await repo.ensureReady();
    // 闲时任务中断恢复：scheduler 是 app 单例、先于任何派发启动——此刻 DB 里的
    // running 必属上一个 app 实例残留，安全置回 queued（session 保留供 resume 续跑）。
    try {
      const recovered =
        options.offPeakEnabled === false ? 0 : await offPeakRepo.recoverInterrupted(Date.now());
      if (recovered > 0) {
        log("info", `off-peak recovered ${recovered} interrupted task(s) back to queued`, {
          event: "automation.scheduler.recovery",
          outcome: "succeeded",
        });
      }
    } catch (error) {
      log(
        "error",
        `off-peak recoverInterrupted failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          event: "automation.scheduler.recovery",
          outcome: "failed",
          reason: "native_write_failed",
        },
      );
    }
    if (disposed) return;
    schedulerReady = true;
    log("info", "cron scheduler started", {
      event: "automation.scheduler.started",
      outcome: "succeeded",
    });
    requestTick();
    pollTimer = setInterval(requestTick, POLL_INTERVAL_MS);
    // 资源遥测：60 秒自采一次 CPU / 内存发给 main（heap 只有本进程读得到）。
    resourceTelemetry = startSchedulerResourceTelemetry({
      postMessage: (message) => options.postMessage(message),
    });
  }

  const ready = main();
  return { ready, acceptMessage, dispose };
}
