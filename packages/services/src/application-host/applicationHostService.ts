import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { ApplicationHostControlPort, IApplicationHostService } from "./contract.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { ICredentialService } from "../credential/credential.js";
import type { ConversationSyncHost, ConversationRuntimePort } from "@zcode/shared";
import type { IProjectService } from "../project/contract.js";
import type { IModelSelectionService } from "../model-provider/providerFacadeServices.js";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";

interface ApplicationHostExtension {
  call(method: string, input: unknown): Promise<unknown>;
  dispose(): Promise<void>;
  control?: ApplicationHostControlPort["control"];
  beforeAutomationInput?: ApplicationHostControlPort["beforeAutomationInput"];
}
const defaultLog = createServiceLogger("application-host");

/** Configured only by the trusted process launcher; never loaded from RPC input. */
export function createApplicationHostService(options: {
  native: IZCodeAgentService;
  conversations?: ConversationSyncHost;
  runtime?: ConversationRuntimePort;
  projects?: Pick<IProjectService, "readProjects">;
  models?: Pick<IModelSelectionService, "getView">;
  credentials: ICredentialService;
  storageRoot: string;
  modulePath?: string;
  surface?: string;
  /** Trusted host diagnostic sink; never configurable through browser RPC. */
  logger?: ServiceLogger;
  onControlReady?: (port: ApplicationHostControlPort) => void;
}): IApplicationHostService & { dispose(): Promise<void> } {
  const log = options.logger ?? defaultLog;
  let pending: Promise<ApplicationHostExtension> | undefined;
  let disposed = false;
  async function extension() {
    if (disposed) throw new Error("application_host_closed");
    if (!options.modulePath || !isAbsolute(options.modulePath))
      throw new Error("application_host_unavailable");
    pending ??= import(pathToFileURL(options.modulePath).href).then(async (module) => {
      if (typeof module.createApplicationHost !== "function")
        throw new Error("application_host_invalid_module");
      const value: unknown = await module.createApplicationHost({
        native: options.native,
        projects: options.projects,
        models: options.models,
        conversations: options.conversations,
        runtime: options.runtime,
        credentials: options.credentials,
        storageRoot: join(options.storageRoot, "application"),
        surface: options.surface,
        logger: {
          info: (...args: unknown[]) => log.info(undefined, ...args),
          warn: (...args: unknown[]) => log.warn(undefined, ...args),
        },
      });
      if (
        !value ||
        typeof value !== "object" ||
        !("call" in value) ||
        typeof value.call !== "function" ||
        !("dispose" in value) ||
        typeof value.dispose !== "function"
      )
        throw new Error("application_host_invalid_module");
      log.info(undefined, "Application Host initialized", {
        event: "application.host.lifecycle",
        outcome: "initialized",
      });
      return value as ApplicationHostExtension;
    });
    return pending;
  }
  // 来源恢复随 Host 启动，不能依赖浏览器再次发起调用才能消费持久意图。
  if (options.modulePath && isAbsolute(options.modulePath)) {
    void extension().catch(() =>
      log.warn(undefined, "Application Host startup failed", {
        event: "application.host.lifecycle",
        outcome: "failed",
      }),
    );
  }
  async function invoke(kind: "call" | "control", method: string, input: unknown) {
    const start = performance.now();
    const correlationId = randomUUID();
    const validMethod = /^[a-z][a-zA-Z0-9]{0,63}$/.test(method);
    const references: { commandId?: string; sessionId?: string } = {};
    if (input && typeof input === "object" && !Array.isArray(input)) {
      for (const key of ["commandId", "sessionId"] as const) {
        const value: unknown = Object.getOwnPropertyDescriptor(input, key)?.value;
        if (
          typeof value === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        )
          references[key] = value;
      }
    }
    const metadata = {
      event: `application.host.${kind}`,
      correlationId,
      method: validMethod ? method : "invalid",
      ...references,
    };
    // 扩展初始化或调用可能一直等待；先记同一关联的 started，不能只依赖最终返回才留下证据。
    log.info(undefined, "Application Host method started", {
      ...metadata,
      outcome: "started",
      durationMs: 0,
    });
    let invalidRequest = !validMethod;
    try {
      invalidRequest ||= Buffer.byteLength(JSON.stringify(input) ?? "") > 65536;
      if (invalidRequest) throw new Error("application_host_invalid_request");
      const port = await extension();
      if (kind === "control" && !port.control) throw new Error("application_control_unavailable");
      const result =
        kind === "control" ? await port.control!(method, input) : await port.call(method, input);
      log.info(undefined, "Application Host method completed", {
        ...metadata,
        outcome: "completed",
        durationMs: performance.now() - start,
      });
      return result;
    } catch {
      // 线上 Core 丢弃 stdio 时旧日志只剩通用错误；保留有界方法/耗时，不把参数和异常带入诊断。
      log.warn(undefined, "Application Host method failed", {
        ...metadata,
        outcome: "failed",
        durationMs: performance.now() - start,
        reasonCode: invalidRequest ? "invalid_request" : "extension_failed",
      });
      throw new Error(
        invalidRequest
          ? "application_host_invalid_request"
          : kind === "control"
            ? "application_control_request_failed"
            : "application_host_request_failed",
      );
    }
  }
  const privatePort: ApplicationHostControlPort = {
    async control(method, input) {
      return invoke("control", method, input);
    },
    async beforeAutomationInput(input) {
      if (!options.modulePath) return "admitted";
      try {
        const port = await extension();
        const result = port.beforeAutomationInput
          ? await port.beforeAutomationInput(input)
          : "admitted";
        const attached =
          typeof result === "object" &&
          result !== null &&
          result.state === "admitted" &&
          result.context &&
          typeof result.context.filename === "string" &&
          /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(result.context.filename) &&
          typeof result.context.text === "string" &&
          Buffer.byteLength(result.context.text) <= 16384;
        if (
          !(
            typeof result === "string" && ["admitted", "blocked", "unavailable"].includes(result)
          ) &&
          !attached
        )
          throw new Error("application_admission_invalid");
        log.info(undefined, "Application admission checked", {
          outcome: typeof result === "string" ? result : result.state,
          runId: input.inputId,
          automationId: input.automationId,
        });
        return result;
      } catch {
        log.warn(undefined, "Application admission unavailable", {
          outcome: "unavailable",
          runId: input.inputId,
          automationId: input.automationId,
        });
        return "unavailable";
      }
    },
  };
  options.onControlReady?.(privatePort);
  return {
    async call(method, input) {
      return invoke("call", method, input);
    },
    async dispose() {
      disposed = true;
      if (pending) {
        try {
          await (await pending).dispose();
          log.info(undefined, "Application Host disposed", {
            event: "application.host.lifecycle",
            outcome: "disposed",
          });
        } catch {
          log.warn(undefined, "Application Host disposal failed", {
            event: "application.host.lifecycle",
            outcome: "failed",
          });
        }
      }
    },
  };
}
