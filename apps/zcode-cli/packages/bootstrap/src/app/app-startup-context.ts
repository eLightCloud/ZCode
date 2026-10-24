import { resolve } from "node:path";

import { createNodeLoggerFactory } from "@zcode/adapters/logging";

import { createConfig } from "@zcode/adapters/config";

import { createModelTelemetry } from "@zcode/telemetry";

import {
  createRootTraceContext,
  createSessionId,
  traceContextToLogContext,
} from "@zcode/contracts";

import { StartupTimer, startupNow } from "../startup-logging.js";

import type { ZCodeAppOptions } from "./app-option-types.js";

import { createConfigCliOverrides, resolveEffectiveConfigResult } from "./app-config-options.js";

import { markConfigurationLoaded, startAppStartup } from "./startup-marks.js";

export function createAppStartupContext(options: ZCodeAppOptions) {
  if (!options?.providerRegistry) {
    throw new Error("createZCodeApp requires a Provider Registry");
  }

  const startupStartedAt = startupNow();
  const appVersion = options.version ?? "0.0.0";
  const sessionId = options.sessionId ?? createSessionId();
  const traceContext = options.traceContext ?? createRootTraceContext({ sessionId });
  const workingDirectory = resolve(options.runtimeConfig?.workingDirectory ?? process.cwd());
  const configResult = resolveEffectiveConfigResult(
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
    }),
    options,
  );
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env: options.env });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap",
  });
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap",
      startupKind: "zcode_app",
    },
    startupStartedAt,
  );
  startAppStartup({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    resume: options.resume === true,
    startupTimer,
  });
  markConfigurationLoaded({
    configResult,
    startupTimer,
  });
  const modelLogger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "adapters.model",
  });
  const modelTelemetry = createModelTelemetry({
    owner: options.telemetryOwner,
    sessionId,
  });
  return {
    configResult,
    traceContext,
    logger,
    workingDirectory,
    startupTimer,
    appVersion,
    sessionId,
    modelLogger,
    modelTelemetry,
    loggerFactory,
  };
}
