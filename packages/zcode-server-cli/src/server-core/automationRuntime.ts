import type { ServiceCollection } from "@zcode/services";
import {
  AutomationRepo,
  createAutomationDispatcher,
  createServiceLogger,
  startAutomationScheduler,
  type AutomationSchedulerHandle,
  type SchedulerToMainMessage,
} from "@zcode/services/node";
import { isRemoteWorkspaceIdentity, type ZCodeAutomation, type ZCodeAutomationRun } from "@zcode/shared";

/** One Core owns one native data root. No timer or claim state is owned here. */
export function startServerAutomationRuntime(services: ServiceCollection, databasePath?: string) {
  const logger = createServiceLogger("server-automation");
  const repo = new AutomationRepo(databasePath);
  const dispatcher = createAutomationDispatcher({
    repo,
    clientMode: "web-remote-replayable",
    resolveServices(request) {
      // Server Core 没有 Desktop 的 RemoteConnectionRegistry；远端目标不能退到本机。
      if (request.workspaceIdentity && isRemoteWorkspaceIdentity(request.workspaceIdentity)) {
        throw new Error("Automation target requires a different Host");
      }
      return services;
    },
    logWarn: (_message, _error) => logger.warn(undefined, {
      event: "automation.persistence", outcome: "failed", reason: "native_write_failed",
    }),
  });
  const dispatches = new Set<Promise<void>>();
  let scheduler: AutomationSchedulerHandle;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const dispatch = async (request: Extract<SchedulerToMainMessage, { type: "cron-dispatch-request" }>) => {
    logger.info(undefined, {
      event: "automation.dispatch", outcome: "started", runId: request.runId,
      automationId: request.automationId,
    });
    try {
      const result = await dispatcher.dispatch(request);
      scheduler.acceptMessage({ type: "cron-dispatch-result", runId: request.runId, ok: true, ...result });
      logger.info(undefined, {
        event: "automation.dispatch", outcome: "accepted", runId: request.runId,
        automationId: request.automationId, sessionId: result.sessionId,
      });
    } catch {
      // 异常可含 prompt、路径或提供方响应；公共派发回执仅保留稳定低敏原因。
      scheduler.acceptMessage({ type: "cron-dispatch-result", runId: request.runId,
        ok: false, error: "native_dispatch_failed", failureKind: "permanent" });
      logger.warn(undefined, {
        event: "automation.dispatch", outcome: "failed", reason: "native_dispatch_failed",
        runId: request.runId, automationId: request.automationId,
      });
      throw new Error("Native automation dispatch failed");
    }
  };
  const track = (work: Promise<void>) => {
    dispatches.add(work);
    void work.then(() => dispatches.delete(work), () => dispatches.delete(work));
    return work;
  };
  scheduler = startAutomationScheduler({
    databasePath,
    offPeakEnabled: false,
    postMessage(message) {
      if (message.type === "cron-dispatch-request") {
        if (disposed) {
          scheduler.acceptMessage({ type: "cron-dispatch-result", runId: message.runId,
            ok: false, error: "native_host_stopping", failureKind: "transient" });
          return;
        }
        void track(dispatch(message)).catch(() => {});
      } else if (message.type === "scheduler-log") {
        // Scheduler 的错误原文可能含目标或数据库路径；Server 只记录级别和稳定事件。
        logger[message.level](undefined, { event: "automation.scheduler", outcome: message.level });
      }
    },
  });
  return {
    ready: scheduler.ready,
    async runManual(params: { automation: ZCodeAutomation; run: ZCodeAutomationRun }): Promise<void> {
      if (disposed) throw new Error("Native automation runtime is stopping");
      await track(dispatch({ type: "cron-dispatch-request",
        automationId: params.automation.automationId, runId: params.run.runId,
        prompt: params.automation.prompt, targetTaskId: params.automation.targetTaskId,
        modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
        mode: params.automation.mode, workspacePath: params.automation.workspacePath,
        workspaceIdentity: params.automation.workspaceIdentity }));
    },
    dispose(): Promise<void> {
      return disposal ??= (async () => {
        disposed = true;
        // 先收口已派发输入及回执，防止释放认领后旧 admission 才成功。
        await Promise.allSettled(dispatches);
        await scheduler.dispose();
        await dispatcher.dispose();
        repo.close();
      })();
    },
  };
}
