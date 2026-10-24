import {
  createLocalServices,
  disposeServiceResourcesAndWait,
  materializeZCodeBuiltinProviderConfig,
  getAppConfigDir,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  createTopicResourcePeers,
} from "@zcode/services/node";
import { IZCodeAgentService, IApplicationHostService } from "@zcode/services";
import { ZCODE_VERSION } from "@zcode/shared";
import { createCoreHttpServer } from "./http.js";
import { installParentDisconnectHandler } from "./parentDisconnect.js";
import { resolveCoreServerId } from "./serverIdentity.js";
import { createTaskActivityTracker } from "./taskActivityTracker.js";
import { startServerAutomationRuntime } from "./automationRuntime.js";
import { DataRootLock } from "../runtime/lock.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { join } from "node:path";
import { CORE_WRITER_WAIT_MS } from "../contracts.js";
import { coreCommandSchema } from "../contracts.js";
import type { LocalRuntimeMaintenance } from "@zcode/shared";
import { CoreMaintenance, readMaintenanceOperation } from "./maintenance.js";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export async function runServerCore(generation: number): Promise<void> {
  let shutdown: ((reason: string) => Promise<void>) | undefined;
  let parentDisconnected = false;
  let startupStopReason: string | undefined;
  const startup = new AbortController();
  const requestStop = (reason: string): void => {
    if (shutdown) {
      void shutdown(reason);
      return;
    }
    startupStopReason = reason;
    startup.abort();
  };
  // writer guard 等待期间也走同一停止入口，不能把 SIGTERM 留到超时后才处理。
  process.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "command" in message &&
      message.command === "shutdown"
    )
      requestStop("requested");
  });
  process.once("SIGTERM", () => requestStop("SIGTERM"));
  process.once("SIGINT", () => requestStop("SIGINT"));
  let disposeParentDisconnectHandler = (): void => undefined;
  disposeParentDisconnectHandler = installParentDisconnectHandler(() => {
    if (shutdown) void shutdown("parent-disconnected");
    else {
      parentDisconnected = true;
      requestStop("parent-disconnected");
    }
  });
  // Supervisor 异常死亡后旧 Core 可能仍在排空；独立 writer guard 禁止新 Core 并写。
  const writerLock = new DataRootLock(
    join(resolveServerLayout(process.env.ZCODE_SERVER_ROOT).runDir, "core.lock"),
  );
  try {
    await writerLock.acquire({
      waitMs: CORE_WRITER_WAIT_MS,
      signal: startup.signal,
      onBlocked: () => {
        if (process.connected)
          process.send?.({ type: "startup-wait", reason: "writer-lock-busy" }, () => undefined);
      },
    });
  } catch (error) {
    if (startupStopReason) process.exit(0);
    throw error;
  }
  if (startupStopReason) process.exit(0);
  const topicResourcePeers = createTopicResourcePeers();
  const explicitZCodeBuiltinProviderConfigFilePath =
    process.env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const zcodeBuiltinProviderConfigFilePath = explicitZCodeBuiltinProviderConfigFilePath
    ? explicitZCodeBuiltinProviderConfigFilePath
    : typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ === "string"
      ? await materializeZCodeBuiltinProviderConfig({
          environmentConfigRoot: getAppConfigDir(),
          content: __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__,
        })
      : undefined;
  if (!zcodeBuiltinProviderConfigFilePath) {
    throw new Error(
      `当前构建未嵌入 ZCode Built-in Provider Config，且未设置 ${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV}`,
    );
  }
  const automationEnabled = process.env.ZCODE_SERVER_AUTOMATION_ENABLED === "1";
  const maintenanceFile = join(
    resolveServerLayout(process.env.ZCODE_SERVER_ROOT).runDir,
    "maintenance.json",
  );
  const maintenanceOperation = await readMaintenanceOperation(maintenanceFile);
  if (automationEnabled && maintenanceOperation) {
    throw new Error("Native automation cannot start while maintenance is held");
  }
  let localMaintenance: LocalRuntimeMaintenance | undefined;
  let continuation: import("@zcode/shared").ConversationRuntimePort | undefined;
  let automation: ReturnType<typeof startServerAutomationRuntime> | undefined;
  const services = createLocalServices({
    onLocalMaintenanceReady: (port) => {
      localMaintenance = port;
    },
    onConversationRuntimeReady: (port) => {
      continuation = port;
    },
    zcodeBuiltinProviderConfigFilePath,
    serviceAuthorityMode: "standalone-server",
    topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
    ...(automationEnabled
      ? {
          onAutomationManualRunRequested: async (params) => {
            if (!automation) throw new Error("Native automation runtime is unavailable");
            await automation.runManual(params);
          },
        }
      : {}),
  });
  const activitySource = services.getOptional(IZCodeAgentService);
  const taskActivityTracker = createTaskActivityTracker(activitySource);
  const configuredPort = process.env.ZCODE_SERVER_PORT?.trim();
  const bindPort = configuredPort ? Number(configuredPort) : undefined;
  if (bindPort !== undefined && (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535)) {
    throw new Error("Invalid configured server port");
  }
  const bindHost = process.env.ZCODE_SERVER_HOST?.trim();
  const authToken = process.env.ZCODE_SERVER_AUTH_TOKEN?.trim();
  const authTokenHash = process.env.ZCODE_SERVER_AUTH_TOKEN_SHA256?.trim();
  const serverId = await resolveCoreServerId();
  const http = await createCoreHttpServer(services, {
    continuation,
    continuationIdentity: () =>
      services.get(IApplicationHostService).call("conversationRuntimeIdentity", {}),
    ...(bindHost ? { host: bindHost } : {}),
    ...(bindPort === undefined ? {} : { port: bindPort }),
    ...(authToken ? { authToken } : {}),
    ...(authTokenHash ? { authTokenHash } : {}),
    serverId,
    initiallyPaused: maintenanceOperation !== null,
    topicResourcePeers,
  });
  if (automationEnabled) {
    automation = startServerAutomationRuntime(services, { serverId });
    await automation.ready;
  }
  const send = (message: unknown): Promise<void> => {
    if (typeof process.send !== "function" || process.connected === false) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        process.send?.(message, () => resolve());
      } catch {
        // 父进程断连后的最后一条生命周期消息不应阻塞资源释放。
        resolve();
      }
    });
  };
  let shutdownStarted = false;
  const maintenance = new CoreMaintenance(
    maintenanceFile,
    http,
    localMaintenance,
    () =>
      shutdownStarted ||
      !activitySource ||
      automationEnabled ||
      taskActivityTracker.readRunningTaskCount() > 0,
    maintenanceOperation,
  );
  process.on("message", (message: unknown) => {
    const parsed = coreCommandSchema.safeParse(message);
    if (!parsed.success || parsed.data.command !== "maintenance") return;
    const request = parsed.data;
    void maintenance.handle(request.input).then(
      (result) => send({ type: "maintenance-result", requestId: request.requestId, result }),
      () =>
        send({
          type: "maintenance-result",
          requestId: request.requestId,
          result: {
            operationId: request.input.operationId,
            state: "blocked",
            reasonCode: "unconfirmed",
          },
        }),
    );
  });
  // ready.version 的语义是 Core 版本；不能误发 Node runtime 版本常量
  // （22.16.0），否则消费方读取会拿到错误值。
  await send({
    type: "ready",
    host: http.host,
    port: http.port,
    version: ZCODE_VERSION,
    generation,
  });
  let lastRunningTaskCount = taskActivityTracker.readRunningTaskCount();
  const activitySubscription = taskActivityTracker.onDidChangeRunningTaskCount(
    (runningTaskCount) => {
      lastRunningTaskCount = runningTaskCount;
      void send({ type: "task-activity", runningTaskCount });
    },
  );
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = Promise.resolve(taskActivityTracker.readRunningTaskCount())
      .then((runningTaskCount) => {
        if (runningTaskCount !== lastRunningTaskCount) {
          lastRunningTaskCount = runningTaskCount;
          void send({ type: "task-activity", runningTaskCount });
        }
        void send({ type: "heartbeat", at: Date.now(), runningTaskCount });
      })
      .catch(() => {
        void send({ type: "heartbeat", at: Date.now(), runningTaskCount: lastRunningTaskCount });
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, 10_000);
  shutdown = async (reason: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    disposeParentDisconnectHandler();
    clearInterval(heartbeat);
    activitySubscription.dispose();
    taskActivityTracker.dispose();
    await http.close().catch(() => undefined);
    await automation?.dispose();
    await disposeServiceResourcesAndWait(services).catch(() => undefined);
    await send({ type: "shutdown-ack" });
    await send({ type: "exit", reason });
    try {
      process.disconnect?.();
    } catch {
      // 父进程已断连时 disconnect 可能报告 IPC_CHANNEL_CLOSED；不影响资源已释放后的退出。
    }
    // 仅设置 exitCode 无法关闭 Agent/SQLite 等仍持有的事件循环；Supervisor 的有界停止
    // 会因此等待到超时。资源释放完成后显式退出，确保 stop/restart/uninstall 真正收口。
    // writer guard 保持到真实进程退出，不能在最后 IPC 回执前提前开放另一个 writer。
    process.exit(0);
  };
  if (parentDisconnected || startupStopReason)
    void shutdown(startupStopReason ?? "parent-disconnected");
  process.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "command" in message &&
      message.command === "shutdown-if-idle"
    ) {
      // 条件停止沿同一个 residency owner 收口；零 turn 不能证明后台 / 审批已结束。
      void maintenance.prepareIdleStop().then(
        (prepared) => {
          if (shutdownStarted) return;
          if (prepared) void shutdown("idle");
          else void send({ type: "idle-stop-blocked" });
        },
        () => {
          void send({ type: "idle-stop-blocked" });
        },
      );
      return;
    }
  });
}
