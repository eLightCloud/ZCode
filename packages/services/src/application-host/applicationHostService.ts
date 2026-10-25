import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ApplicationHostControlPort, IApplicationHostService } from "./contract.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { ICredentialService } from "../credential/credential.js";
import type { ConversationSyncHost, ConversationRuntimePort } from "@zcode/shared";
import type { IProjectService } from "../project/contract.js";
import type { IModelSelectionService } from "../model-provider/providerFacadeServices.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

interface ApplicationHostExtension {
  call(method: string, input: unknown): Promise<unknown>;
  dispose(): Promise<void>;
  control?: ApplicationHostControlPort["control"];
  beforeAutomationInput?: ApplicationHostControlPort["beforeAutomationInput"];
}
const log = createServiceLogger("application-host");

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
  onControlReady?: (port: ApplicationHostControlPort) => void;
}): IApplicationHostService & { dispose(): Promise<void> } {
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
      log.info(undefined, "Application Host initialized", { outcome: "initialized" });
      return value as ApplicationHostExtension;
    });
    return pending;
  }
  // 来源恢复随 Host 启动，不能依赖浏览器再次发起调用才能消费持久意图。
  if (options.modulePath && isAbsolute(options.modulePath)) {
    void extension().catch(() =>
      log.warn(undefined, "Application Host startup failed", { outcome: "failed" }),
    );
  }
  const privatePort: ApplicationHostControlPort = {
    async control(method, input) {
      if (
        !/^[a-z][a-zA-Z0-9]{0,63}$/.test(method) ||
        Buffer.byteLength(JSON.stringify(input) ?? "") > 65536
      )
        throw new Error("application_host_invalid_request");
      try {
        const port = await extension();
        if (!port.control) throw new Error("application_control_unavailable");
        const result = await port.control(method, input);
        log.info(undefined, "Application control completed", { method, outcome: "completed" });
        return result;
      } catch {
        log.warn(undefined, "Application control failed", { method, outcome: "failed" });
        throw new Error("application_control_request_failed");
      }
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
      if (
        !/^[a-z][a-zA-Z0-9]{0,63}$/.test(method) ||
        Buffer.byteLength(JSON.stringify(input) ?? "") > 65536
      )
        throw new Error("application_host_invalid_request");
      try {
        return await (await extension()).call(method, input);
      } catch {
        log.warn(undefined, "Application Host call failed", { method, outcome: "failed" });
        throw new Error("application_host_request_failed");
      }
    },
    async dispose() {
      disposed = true;
      if (pending) {
        try {
          await (await pending).dispose();
        } catch {
          log.warn(undefined, "Application Host disposal failed", { outcome: "failed" });
        }
      }
    },
  };
}
