import { ConfigResult } from "@zcode/adapters/config";

import { AgentRuntime, AgentRuntimeConfig } from "@zcode/core";

import { createSessionEvent, Logger, SessionId, type TraceContext } from "@zcode/contracts";

import type { ZCodeAppOptions } from "./types.js";

import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";

export function createAppHookSecurity(
  appVersion: string,
  logger: Logger,
  options: ZCodeAppOptions,
  configResult: ConfigResult,
  runtimeConfig: AgentRuntimeConfig,
  sessionId: SessionId,
  workingDirectory: string,
  getRuntime: () => AgentRuntime,
  traceContext: TraceContext,
) {
  return createWorkspaceHookRuntimeSecurity({
    appVersion,
    logger,
    projectConfigPath: options.projectConfigPath,
    policy: options.workspaceHookPolicy,
    policyProvider: options.workspaceHookPolicyProvider,
    reviewHost: options.workspaceHookReviewHost,
    workspaceHookTrustEnabled: options.workspaceHookTrustEnabled,
    runtimeRoot: configResult.sources.project.workspaceHookRuntimeRoot ?? {
      // Fallback 只在 config-factory 未导出时生效（理论上不会发生）。
      // 此处原本无条件按单层 runtimeConfig.hooks 重建 runtimeRoot，与
      // config-factory 遍历 default/user/project/env/cli 全部层的推导不一致，
      // 导致 review 快照与 toggle 重建的 bundleDigest 不同，
      // 「审核中 toggle」被误报为 workspace_hooks_snapshot_mismatch。
      enabled: runtimeConfig.hooks?.enabled === true,
      timeoutMs: runtimeConfig.hooks?.timeoutMs ?? 60000,
      maxOutputBytes: runtimeConfig.hooks?.maxOutputBytes ?? 32768,
    },
    sessionId,
    snapshot: configResult.sources.project.workspaceHookSnapshot,
    userConfigPath: configResult.sources.user.path,
    workingDirectory,
    ...(options.workspaceHookReviewHost
      ? {
          emitReviewEvent: async (event) => {
            await getRuntime().appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
          emitAdmissionEvent: async (event) => {
            await getRuntime().appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
        }
      : {}),
  });
}
