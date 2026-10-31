import { createServiceLogger, type ServiceLogger } from "@zcode/services/node";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { createServerHostServices } from "@zcode/services/node";
import { disposeServiceResourcesAndWait } from "@zcode/services/node";
import { materializeZCodeBuiltinProviderConfig } from "@zcode/services/node";
import { getAppConfigDir } from "@zcode/services/node";
import { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV } from "@zcode/services/node";
import { createTopicResourcePeers } from "@zcode/services/node";
import { IZCodeAgentService, IApplicationHostService } from "@zcode/services";
import { ZCODE_VERSION } from "@zcode/shared";
import { createCoreHttpServer } from "./http.js";
import { createIngressToken } from "./ingressToken.js";
import { installParentDisconnectHandler } from "./parentDisconnect.js";
import { resolveCoreServerId } from "./serverIdentity.js";
import { createTaskActivityTracker } from "./taskActivityTracker.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { startServerAutomationRuntime } from "./automationRuntime.js";
import { DataRootLock } from "../runtime/lock.js";
import { join } from "node:path";
import { CORE_WRITER_WAIT_MS } from "../contracts.js";
import { coreCommandSchema } from "../contracts.js";
import type { LocalRuntimeMaintenance } from "@zcode/shared";
import { CoreMaintenance } from "./maintenance.js";
import { readMaintenanceOperation } from "./maintenance.js";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export interface CoreDiagnosticLog {
  logger: ServiceLogger;
  flush(timeoutMs?: number): Promise<{ flushed: boolean; dropped: number; writeFailures: number }>;
}

/** Core-owned metadata log, deliberately independent from arbitrary child stdio. */
export function createCoreDiagnosticLog(
  directory: string,
  generation: number,
  limits: { maxFileBytes?: number; maxQueuedBytes?: number } = {},
): CoreDiagnosticLog {
  const maxFileBytes = limits.maxFileBytes ?? 1024 * 1024;
  const maxQueuedBytes = limits.maxQueuedBytes ?? 64 * 1024;
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes < 512 ||
    !Number.isSafeInteger(maxQueuedBytes) ||
    maxQueuedBytes < 512
  )
    throw new Error("Invalid Core diagnostic bounds");
  const path = join(directory, "core.log");
  let pending = Promise.resolve();
  let queuedBytes = 0,
    dropped = 0,
    unreportedDrops = 0,
    writeFailures = 0;
  async function ignoreMissing(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  async function append(line: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await ignoreMissing(async () => {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Core diagnostic symlink rejected");
    });
    const flags =
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
    let file = await open(path, flags, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Core diagnostic target is not a file");
      if (stat.size + Buffer.byteLength(line) > maxFileBytes) {
        // Windows 不允许重命名仍打开的文件；所有平台先关闭 append，再轮转固定的三个路径。
        await file.close();
        await ignoreMissing(() => unlink(path + ".2"));
        await ignoreMissing(() => rename(path + ".1", path + ".2"));
        await ignoreMissing(() => rename(path, path + ".1"));
        file = await open(path, flags, 0o600);
      }
      await file.writeFile(line);
    } finally {
      await file.close();
    }
  }
  function record(level: "info" | "warn" | "error", args: unknown[]): void {
    const metadata = args.at(-1);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
    const value = metadata as Record<string, unknown>;
    if (
      typeof value.event !== "string" ||
      ![
        "application.host.call",
        "application.host.control",
        "application.host.lifecycle",
        "application.host.extension",
        "server.rpc.failure",
        "server.startup",
      ].includes(value.event)
    )
      return;
    // 只复制逐字段白名单；不能 stringify 输入对象、异常、扩展日志正文或 RPC 的附加参数。
    const safe: Record<string, string | number> = {
      timestamp: new Date().toISOString(),
      level,
      generation,
      pid: process.pid,
      event: value.event,
    };
    for (const key of [
      "method",
      "channel",
      "outcome",
      "phase",
      "reasonCode",
      "correlationId",
      "clientMode",
    ])
      if (typeof value[key] === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value[key]))
        safe[key] = value[key];
    for (const key of ["commandId", "sessionId"])
      if (
        typeof value[key] === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value[key])
      )
        safe[key] = value[key];
    if (
      typeof value.durationMs === "number" &&
      Number.isFinite(value.durationMs) &&
      value.durationMs >= 0
    )
      safe.durationMs = Math.round(value.durationMs * 10) / 10;
    const line = JSON.stringify(safe) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > maxFileBytes || queuedBytes + bytes > maxQueuedBytes) {
      dropped++;
      unreportedDrops++;
      return;
    }
    queuedBytes += bytes;
    pending = pending.then(async () => {
      try {
        await append(line);
        if (unreportedDrops) {
          const count = unreportedDrops;
          await append(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "warn",
              event: "server.diagnostics.dropped",
              generation,
              count,
            }) + "\n",
          );
          unreportedDrops -= count;
        }
      } catch {
        writeFailures++;
      } finally {
        queuedBytes -= bytes;
      }
    });
  }
  return {
    logger: {
      debug: () => undefined,
      info: (_traceId, ...args) => record("info", args),
      warn: (_traceId, ...args) => record("warn", args),
      error: (_traceId, ...args) => record("error", args),
    },
    async flush(timeoutMs = 500) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flushed = await Promise.race([
        pending.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      return { flushed, dropped, writeFailures };
    },
  };
}

export async function runServerCore(
  generation: number,
  diagnostics?: CoreDiagnosticLog,
): Promise<void> {
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
  const startupCleanup: Array<() => Promise<unknown> | void> = [disposeParentDisconnectHandler];
  try {
    const layout = resolveServerLayout(process.env.ZCODE_SERVER_ROOT?.trim());
    const topicResourcePeers = createTopicResourcePeers();
    const explicitZCodeBuiltinProviderConfigFilePath =
      process.env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
    // Built-in Config 物化到所属 Environment 配置根（~/.zcode/v2）而不是 release 自带的 runtime 目录：
    // release 目录是不可变的，同一 releaseId 重装时 assertExistingReleaseMatches 会重算整棵树的
    // 内容哈希，多出的物化文件会让校验失败。
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
    let applicationControl: import("@zcode/services/node").ApplicationHostControlPort | undefined;
    const sourceServerId = (await resolveCoreServerId()) ?? hostname() ?? "zcode-server";
    const { services, workspaceIdentityMapper, migrationFailedPathCount } =
      await createServerHostServices({
        applicationHostLogger: diagnostics?.logger,
        onApplicationControlReady: (port) => {
          applicationControl = port;
        },
        sourceServerId,
        onLocalMaintenanceReady: (port) => {
          localMaintenance = port;
        },
        onConversationRuntimeReady: (port) => {
          continuation = port;
        },
        zcodeBuiltinProviderConfigFilePath,
        providerProvisioningTargetEnabled: true,
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
    startupCleanup.push(() => disposeServiceResourcesAndWait(services));
    const activitySource = services.getOptional(IZCodeAgentService);
    const taskActivityTracker = createTaskActivityTracker(activitySource);
    startupCleanup.push(() => taskActivityTracker.dispose());
    const configuredPort = process.env.ZCODE_SERVER_PORT?.trim();
    const bindPort = configuredPort ? Number(configuredPort) : undefined;
    if (
      bindPort !== undefined &&
      (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535)
    ) {
      throw new Error("Invalid configured server port");
    }
    const bindHost = process.env.ZCODE_SERVER_HOST?.trim();
    const authToken = process.env.ZCODE_SERVER_AUTH_TOKEN?.trim();
    const authTokenHash = process.env.ZCODE_SERVER_AUTH_TOKEN_SHA256?.trim();
    const serverId = sourceServerId;
    const ingressToken = authToken || authTokenHash ? undefined : await createIngressToken(layout);
    const http = await createCoreHttpServer(services, {
      diagnosticLogger: diagnostics?.logger,
      applicationControl: (method, input) => {
        if (!applicationControl) throw new Error("Application control unavailable");
        return applicationControl.control(method, input);
      },
      continuation,
      continuationIdentity: () =>
        services.get(IApplicationHostService).call("conversationRuntimeIdentity", {}),
      ...(bindHost ? { host: bindHost } : {}),
      ...(bindPort === undefined ? {} : { port: bindPort }),
      ...(authToken ? { authToken } : {}),
      ...(authTokenHash ? { authTokenHash } : {}),
      serverId,
      ...(ingressToken ? { ingressToken } : {}),
      migrationFailedPathCount,
      workspaceIdentityMapper,
      initiallyPaused: maintenanceOperation !== null,
      topicResourcePeers,
    });
    startupCleanup.push(() => http.close());
    if (automationEnabled) {
      automation = startServerAutomationRuntime(services, {
        serverId,
        applicationAdmission: (input) =>
          applicationControl
            ? applicationControl.beforeAutomationInput(input)
            : Promise.resolve("admitted"),
      });
      startupCleanup.push(() => automation!.dispose());
      await automation.ready;
    }
    const send = (message: unknown): Promise<void> => {
      if (typeof process.send !== "function" || process.connected === false)
        return Promise.resolve();
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
      ...(process.env.ZCODE_SERVER_RELEASE_ID?.trim()
        ? { releaseId: process.env.ZCODE_SERVER_RELEASE_ID.trim() }
        : {}),
      generation,
    });
    let lastRunningTaskCount = taskActivityTracker.readRunningTaskCount();
    const activitySubscription = taskActivityTracker.onDidChangeRunningTaskCount(
      (runningTaskCount) => {
        lastRunningTaskCount = runningTaskCount;
        void send({
          type: "task-activity",
          runningTasks: taskActivityTracker.readRunningTasks(),
          runningTaskCount,
        });
      },
    );
    startupCleanup.push(() => activitySubscription.dispose());
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = Promise.resolve(taskActivityTracker.readRunningTaskCount())
        .then((runningTaskCount) => {
          if (runningTaskCount !== lastRunningTaskCount) {
            lastRunningTaskCount = runningTaskCount;
            void send({
              type: "task-activity",
              runningTasks: taskActivityTracker.readRunningTasks(),
              runningTaskCount,
            });
          }
          void send({
            type: "heartbeat",
            runningTasks: taskActivityTracker.readRunningTasks(),
            at: Date.now(),
            runningTaskCount,
          });
        })
        .catch(() => {
          void send({
            type: "heartbeat",
            runningTasks: taskActivityTracker.readRunningTasks(),
            at: Date.now(),
            runningTaskCount: lastRunningTaskCount,
          });
        })
        .finally(() => {
          heartbeatInFlight = undefined;
        });
    }, 10_000);
    startupCleanup.push(() => clearInterval(heartbeat));
    const shutdownCore = async (reason: string): Promise<void> => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      disposeParentDisconnectHandler();
      clearInterval(heartbeat);
      activitySubscription.dispose();
      taskActivityTracker.dispose();
      await http.close().catch(() => undefined);
      await automation?.dispose();
      await disposeServiceResourcesAndWait(services).catch(() => undefined);
      await diagnostics?.flush();
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
    shutdown = shutdownCore;
    if (parentDisconnected || startupStopReason)
      void shutdownCore(startupStopReason ?? "parent-disconnected");
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
            if (prepared) void shutdownCore("idle");
            else void send({ type: "idle-stop-blocked" });
          },
          () => {
            void send({ type: "idle-stop-blocked" });
          },
        );
        return;
      }
    });
    // Ownership transfers to the live shutdown path only after initialization completes.
    startupCleanup.length = 0;
  } catch (error) {
    startup.abort();
    let cleanupError: unknown;
    for (const dispose of startupCleanup.reverse()) {
      try {
        await dispose();
      } catch (failure) {
        cleanupError ??= failure;
      }
    }
    (diagnostics?.logger ?? createServiceLogger("server-core")).error(
      undefined,
      "Native Core startup failed",
      {
        event: "server.startup",
        outcome: "failed",
        generation,
        reasonCode: cleanupError ? "cleanup_unconfirmed" : "initialization_failed",
      },
    );
    await diagnostics?.flush();
    // An unconfirmed drain keeps the writer guard until process termination.
    if (cleanupError)
      throw new AggregateError([error, cleanupError], "Core startup cleanup incomplete");
    await writerLock.release();
    throw error;
  }
}
