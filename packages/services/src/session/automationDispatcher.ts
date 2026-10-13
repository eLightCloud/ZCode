import type { IDisposable } from "@zcode/rpc";
import {
  formatModelPickerValue,
  resolveWorkspaceKey,
  type TraceId,
  type ZCodeTaskMode,
  type ModelSelection,
  type ZCodeAutomationRunOutcome,
  type ZCodeTaskClientMode,
} from "@zcode/shared";
import type { ServiceCollection } from "../collection.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { IZCodeTaskService } from "./zcodeTaskService.js";
import { IModelSelectionService } from "../model-provider/providerFacadeServices.js";
import { IBotsService } from "../bots/bots.js";
import type { AutomationRepo } from "./automationRepo.js";
import type {
  AutomationDiagnostic,
  SchedulerToMainMessage,
} from "./automationSchedulerProtocol.js";
import { resolveAutomationSubmissionModelSelection } from "./automationModelSelection.js";
import { watchCronRunBotDelivery } from "./automationBotDelivery.js";
import {
  recordCronRunOutcomeBestEffort,
  startManualClaimHeartbeat,
  settleCronRunTerminalOutcome,
} from "./automationRunLifecycle.js";

export type AutomationDispatchRequest = Omit<
  Extract<SchedulerToMainMessage, { type: "cron-dispatch-request" }>,
  "type"
>;
export interface AutomationDispatcher {
  dispatch(request: AutomationDispatchRequest): Promise<{ taskId: string; sessionId: string }>;
  dispose(): Promise<void>;
}
export function createAutomationDispatcher(options: {
  repo: AutomationRepo;
  resolveServices(request: AutomationDispatchRequest): ServiceCollection;
  clientMode: ZCodeTaskClientMode;
  logWarn(message: string, error: unknown, diagnostic?: AutomationDiagnostic): void;
  onSessionCreated?(event: {
    sessionId: string;
    messageId: TraceId;
    workspaceIdentity?: string;
  }): void;
}): AutomationDispatcher {
  const logger = createServiceLogger("automation-dispatcher");
  const cronRunSubscriptions = new Map<string, IDisposable>();
  const writes = new Set<Promise<unknown>>();
  const admissions = new Set<Promise<{ taskId: string; sessionId: string }>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  function trackWrite(work: Promise<unknown>, diagnostic: AutomationDiagnostic): void {
    writes.add(work);
    void work.then(
      () => writes.delete(work),
      (error) => {
        writes.delete(work);
        options.logWarn("Automation outcome write failed", error, diagnostic);
      },
    );
  }
  function cronRunSubscriptionKey(taskId: string, traceId: TraceId): string {
    return `${taskId}\u0000${traceId}`;
  }

  function parseCronRunScheduledAt(runId: string, automationId: string): number | null {
    const prefix = `${automationId}:`;
    if (!runId.startsWith(prefix)) return null;
    const value = Number(runId.slice(prefix.length).split(":")[0]);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function markCronRunOutcome(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: "schedule" | "manual";
    outcome: ZCodeAutomationRunOutcome;
    error?: string;
  }): void {
    trackWrite(
      recordCronRunOutcomeBestEffort({
        ...params,
        repo: options.repo,
        logWarn: options.logWarn,
      }),
      {
        event: "automation.outcome.write",
        outcome: "failed",
        reason: "native_write_failed",
        runId: params.runId,
        automationId: params.automationId,
      },
    );
  }

  function disposeCronRunSubscription(key: string): void {
    const disposable = cronRunSubscriptions.get(key);
    if (!disposable) return;
    cronRunSubscriptions.delete(key);
    disposable.dispose();
  }

  async function applyCronRunConfigToExistingTask(params: {
    zcodeTaskService: IZCodeTaskService;
    taskId: string;
    traceId: TraceId;
    modelSelection?: ModelSelection;
    mode?: string;
  }): Promise<void> {
    let thoughtAppliedWithModel = false;
    let modeAppliedWithModel = false;
    if (params.modelSelection) {
      await params.zcodeTaskService.setAutomationSessionConfig({
        taskId: params.taskId,
        traceId: params.traceId,
        modelSelection: params.modelSelection,
        thoughtLevel: params.modelSelection.options?.reasoningLevel,
        mode: params.mode?.trim() as ZCodeTaskMode | undefined,
      });
      thoughtAppliedWithModel = true;
      modeAppliedWithModel = true;
    }
    if (!modeAppliedWithModel && params.mode?.trim()) {
      await params.zcodeTaskService.setConfigOption({
        taskId: params.taskId,
        traceId: params.traceId,
        configId: "mode",
        value: params.mode.trim(),
      });
    }
    if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
      await params.zcodeTaskService.setConfigOption({
        taskId: params.taskId,
        traceId: params.traceId,
        configId: "thought_level",
        value: params.modelSelection.options.reasoningLevel,
      });
    }
  }

  function trackCronRunOutcome(params: {
    zcodeTaskService: IZCodeTaskService;
    taskId: string;
    traceId: TraceId;
    workspacePath: string;
    workspaceIdentity?: string;
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: "schedule" | "manual";
  }): void {
    const key = cronRunSubscriptionKey(params.taskId, params.traceId);
    disposeCronRunSubscription(key);
    markCronRunOutcome({ ...params, outcome: "running" });
    const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
      (result) => {
        if (result.inputId !== params.traceId) return;
        logger.info(params.traceId, {
          event: "automation.execution",
          outcome: result.outcome,
          runId: params.runId,
          automationId: params.automationId,
          source: "native_task_terminal",
        });
        trackWrite(
          settleCronRunTerminalOutcome({
            ...params,
            outcome: result.outcome,
            // 提供方异常可能包含请求正文；运行投影只保留稳定低敏原因。
            error: result.error ? "native_execution_failed" : undefined,
            repo: options.repo,
            logWarn: options.logWarn,
          }),
          {
            event: "automation.outcome.write",
            outcome: "failed",
            reason: "native_write_failed",
            runId: params.runId,
            automationId: params.automationId,
          },
        );
        // 定时任务在后台完成后统一置为未读，真正打开 task 时再由导航链路清除。
        trackWrite(
          params.zcodeTaskService
            .setTaskUnread({
              taskId: params.taskId,
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
              unread: true,
            })
            .catch((error) =>
              options.logWarn("Automation unread update failed", error, {
                event: "automation.unread.write",
                outcome: "failed",
                reason: "native_write_failed",
                runId: params.runId,
                automationId: params.automationId,
              }),
            ),
          {
            event: "automation.unread.write",
            outcome: "failed",
            reason: "native_write_failed",
            runId: params.runId,
            automationId: params.automationId,
          },
        );
        disposeCronRunSubscription(key);
      },
    );
    const claimHeartbeat =
      params.trigger === "manual"
        ? startManualClaimHeartbeat({
            ...params,
            repo: options.repo,
            logWarn: options.logWarn,
          })
        : null;
    cronRunSubscriptions.set(key, {
      dispose() {
        claimHeartbeat?.dispose();
        disposable.dispose();
      },
    });
  }

  /**
   * 把一次 cron/manual run 直接提交给当前 host 的 V4 task service。
   * 会话内 automation 可能绑定到未激活 session，必须先恢复再应用保存的运行参数。
   */
  async function dispatchCronRun(request: AutomationDispatchRequest): Promise<{
    taskId: string;
    sessionId: string;
  }> {
    const targetServices = options.resolveServices(request);
    const zcodeTaskService = targetServices.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      throw new Error("ZCode task service is not initialized.");
    }
    const modelSelectionService = targetServices.getOptional(IModelSelectionService);
    if (!modelSelectionService) {
      throw new Error("目标 Host Model Selection service is not initialized.");
    }
    // 长期配置是原意图；首次派发在目标 Host 解析后固定。已有 run 必须直接复用，
    // 不能因账号变化或本次 Registry 读取失败重新解释历史执行选择。
    const existingRun = await options.repo.getRun(request.runId);
    const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
      selection: request.modelSelection,
      fixedSelection: existingRun?.modelSelection,
      modelSelectionService,
      // Repo 已在读取前完成离线导入；不再为迁移绕行 Agent/账号服务。
      // 未迁入或损坏的新值仍由此入口明确拒绝，不能当成跟随 Workspace。
      readSelection: () =>
        options.repo.getModelSelectionForDispatch(
          request.automationId,
          resolveWorkspaceKey(request),
        ),
    });
    const submissionModelSelection = await options.repo.fixRunModelSelection(
      request.runId,
      resolvedSubmissionModelSelection,
    );
    let trackedKey: string | null = null;
    const workspaceKey = resolveWorkspaceKey(request);
    const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
    const scheduledAt = parseCronRunScheduledAt(request.runId, request.automationId);
    try {
      const task = request.targetTaskId
        ? { taskId: request.targetTaskId }
        : await zcodeTaskService.createTask({
            workspacePath: request.workspacePath,
            workspaceIdentity: request.workspaceIdentity,
            model: formatModelPickerValue(submissionModelSelection),
            mode: request.mode as ZCodeTaskMode | undefined,
            thoughtLevel: submissionModelSelection.options?.reasoningLevel,
            automationId: request.automationId,
          });
      // 未绑定会话时不能沿用 createTask 的 session trace 作为首条 prompt trace：
      // CLI 无法从 inputId 还原 manual/schedule admission。
      // 建会话 trace 与执行 runId 是两种身份；两条派发路径的 prompt 都必须统一使用 runId。
      const promptTraceId = request.runId as TraceId;
      if (request.targetTaskId) {
        // 绑定会话在 app 重启或切换 workspace 后通常不处于 active；旧实现直接
        // setConfig/sendPrompt 会立即报 Session is not active，看起来像「立即运行」没有触发。
        await zcodeTaskService.resumeTask({
          taskId: task.taskId,
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          model: formatModelPickerValue(submissionModelSelection),
          thoughtLevel: submissionModelSelection.options?.reasoningLevel,
          automationId: request.automationId,
        });
        await applyCronRunConfigToExistingTask({
          zcodeTaskService,
          taskId: task.taskId,
          traceId: promptTraceId,
          modelSelection: submissionModelSelection,
          mode: request.mode as ZCodeTaskMode | undefined,
        });
      }
      const botsService = targetServices.getOptional(IBotsService);
      if (botsService) {
        try {
          await watchCronRunBotDelivery({
            automationId: request.automationId,
            runId: promptTraceId,
            workspaceKey,
            workspacePath: request.workspacePath,
            ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
            taskId: task.taskId,
            repo: options.repo,
            botsService,
          });
        } catch (error) {
          // Bot 回推是 best-effort 辅助通道；配置/凭据/订阅失败不能阻断 automation 派发与结算。
          options.logWarn(
            `automation Bot delivery subscription failed automation=${request.automationId} provider=unknown`,
            error,
            {
              event: "automation.delivery.subscribe",
              outcome: "failed",
              reason: "native_dispatch_failed",
              runId: request.runId,
              automationId: request.automationId,
            },
          );
        }
      }
      trackedKey = cronRunSubscriptionKey(task.taskId, promptTraceId);
      trackCronRunOutcome({
        zcodeTaskService,
        taskId: task.taskId,
        traceId: promptTraceId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        runId: request.runId,
        automationId: request.automationId,
        workspaceKey,
        scheduledAt,
        trigger,
      });
      await zcodeTaskService.sendPrompt({
        taskId: task.taskId,
        traceId: promptTraceId,
        content: request.prompt,
        clientMode: options.clientMode,
        automationId: request.automationId,
      });
      // prompt 创建的定时任务带 targetTaskId，追加原会话不能计成 session_create。
      if (!request.targetTaskId) {
        options.onSessionCreated?.({
          sessionId: task.taskId,
          messageId: promptTraceId,
          workspaceIdentity: request.workspaceIdentity,
        });
      }
      return { taskId: task.taskId, sessionId: task.taskId };
    } catch (error) {
      if (trackedKey) disposeCronRunSubscription(trackedKey);
      markCronRunOutcome({
        runId: request.runId,
        automationId: request.automationId,
        workspaceKey,
        scheduledAt,
        trigger,
        outcome: "failed",
        // 回执与 outcome 写入可能交错；两条写路径必须使用相同的低敏原因。
        error: "native_dispatch_failed",
      });
      throw error;
    }
  }

  return {
    dispatch(request) {
      if (disposed) return Promise.reject(new Error("Automation dispatcher is disposed"));
      const work = dispatchCronRun(request);
      admissions.add(work);
      void work.then(
        () => admissions.delete(work),
        () => admissions.delete(work),
      );
      return work;
    },
    dispose() {
      return (disposal ??= (async () => {
        disposed = true;
        await Promise.allSettled(admissions);
        for (const key of cronRunSubscriptions.keys()) disposeCronRunSubscription(key);
        await Promise.allSettled(writes);
      })());
    },
  };
}
