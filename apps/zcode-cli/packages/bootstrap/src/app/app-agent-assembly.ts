import { subagentProfilesFromSnapshot } from "../subagent-runtime-config.js";
import type { RuntimeModelFactory } from "./provider-registry-model-runtime.js";

import { createInMemorySessionEventStore } from "@zcode/adapters/storage";

import { ConfigResult, createConfig } from "@zcode/adapters/config";

import { createNodeContextSourceAdapter } from "@zcode/adapters/context";

import { createNodeSkillAdapter } from "@zcode/adapters/skills";

import {
  AgentRuntime,
  AgentRuntimeConfig,
  normalizeAgentProfiles,
  PermissionService,
} from "@zcode/core";

import { ModelTelemetryBootstrap } from "@zcode/telemetry";

import {
  BrowserControlPort,
  DeliverableStorePort,
  DynamicWorkflowSnippetPort,
  ExecutionPort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  Logger,
  McpPort,
  ModelCatalogPort,
  PdfDocumentPort,
  PluginLoadOutcome,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  SkillRoot,
  ToolArtifactStorePort,
  type TraceContext,
} from "@zcode/contracts";

import { isRemoteWorkspaceIdentity } from "@zcode/shared";

import { StartupTimer } from "../startup-logging.js";

import type { ZCodeAppOptions } from "./types.js";

import { createConfigCliOverrides, resolveEffectiveConfigResult } from "./app-config-options.js";

import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";

import { WorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";

import { createScriptWorkflowBridge } from "./script-workflow-methods.js";

import { createDynamicWorkflowRunService } from "./dynamic-workflow-run-service.js";

import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";

import { collectDisabledPaths } from "../skill-command-overrides.js";

import { loadPluginAgentTemplates, resolvePluginAgentProfiles } from "../subagents.js";

import { resolveStartupPlugins } from "./startup-marks.js";

export function createAppAgentRuntime(
  runtime: AgentRuntime | undefined,
  sessionId: SessionId,
  runtimeConfig: AgentRuntimeConfig,
  options: ZCodeAppOptions,
  logger: Logger,
  pluginOutcome: PluginLoadOutcome,
  pluginTemplates: ReturnType<typeof loadPluginAgentTemplates>,
  modelTelemetry: ModelTelemetryBootstrap,
  workflowConcurrencyGovernor: ReturnType<typeof getWorkflowConcurrencyGovernor>,
  sessionStore: SessionStorePort,
  sessionMailboxPort: SessionMailboxPort | undefined,
  executionPort: ExecutionPort,
  workspaceHookRuntimeSecurity: WorkspaceHookRuntimeSecurity | undefined,
  browserControlPort: BrowserControlPort | undefined,
  fileSystemPort: FileSystemPort,
  httpClientPort: HttpClientPort,
  imageProcessorPort: ImageProcessorPort,
  pdfDocumentPort: PdfDocumentPort,
  artifactStore: ToolArtifactStorePort,
  deliverableStore: DeliverableStorePort,
  configResult: ConfigResult,
  workingDirectory: string,
  cliStorageRoot: string,
  startupTimer: StartupTimer,
  bundledSkillRoots: SkillRoot[],
  mcpPort: McpPort | undefined,
  modelFactory: RuntimeModelFactory,
  modelIoDir: string,
  permissionService: PermissionService,
  scriptWorkflowFacade: ReturnType<typeof createScriptWorkflowBridge>,
  dynamicWorkflowRunPort: ReturnType<typeof createDynamicWorkflowRunService> | undefined,
  dynamicWorkflowSnippetPort: DynamicWorkflowSnippetPort,
  modelCatalogPort: ModelCatalogPort,
  appVersion: string,
  traceContext: TraceContext,
) {
  runtime = new AgentRuntime(sessionId, runtimeConfig, {
    ...(options.readSubagentRuntimeConfig
      ? {
          loadAgentDefinitions: async (input) => {
            const snapshot = await options.readSubagentRuntimeConfig!(input);
            const parsed = subagentProfilesFromSnapshot(snapshot);
            const pluginProfiles =
              snapshot.kind === "built-in-fallback"
                ? []
                : resolvePluginAgentProfiles(
                    {
                      logger,
                      plugins: pluginOutcome.plugins,
                      reservedProfileNames: parsed.profiles.map((profile) => profile.name),
                      modelSelectionOverrides: parsed.pluginAgentModelSelectionOverrides,
                    },
                    pluginTemplates,
                  ).profiles;
            return {
              activeAgents: normalizeAgentProfiles(
                [
                  ...(options.runtimeConfig?.subagents?.profiles ?? []),
                  ...parsed.profiles,
                  ...pluginProfiles,
                ],
                {
                  builtInModelSelectionOverrides: {
                    ...parsed.builtInModelSelectionOverrides,
                    ...options.runtimeConfig?.subagents?.builtInModelSelectionOverrides,
                  },
                },
              ),
            };
          },
        }
      : {}),
    agentTelemetry: modelTelemetry.agentExecution,
    // 主代理的模型请求过治理器的 observer：立即放行，但让治理器看见它的 429 / 成功。
    modelRequestAdmission: workflowConcurrencyGovernor.observer(),
    eventStore: options.eventStore ?? createInMemorySessionEventStore(),
    sessionStore,
    sessionMailboxPort,
    logger,
    executionPort,
    workspaceHookAdmission: workspaceHookRuntimeSecurity?.admission,
    workspaceHookSnapshot: workspaceHookRuntimeSecurity?.snapshot,
    browserControlPort,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    pdfDocumentPort,
    artifactStore,
    contextSourcePort:
      options.contextSourcePort ?? createNodeContextSourceAdapter({ env: options.env }),
    deliverableStore,
    skillPort:
      configResult.config.features.skill && configResult.config.skills.enabled
        ? (options.skillPort ??
          createNodeSkillAdapter({
            resolveRequiredPlugins: () => {
              const current = resolveEffectiveConfigResult(
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
              const outcome = resolveStartupPlugins({
                cliStorageRoot,
                configResult: current,
                env: options.env,
                logger,
                options,
                startupTimer,
                workingDirectory,
              });
              if (!current.config.features.skill || !current.config.skills.enabled) {
                outcome.plugins = [];
                outcome.skillRoots = [];
              }
              return {
                outcome,
                disabledPaths: collectDisabledPaths(current.config.skillOverrides),
              };
            },
            extraRoots: configResult.config.skills.roots,
            extraResolvedRoots: [...pluginOutcome.skillRoots, ...bundledSkillRoots],
            disabledPaths: [
              ...collectDisabledPaths(configResult.config.skillOverrides),
              // 动态工作流关闭时不提供 dynamic-workflows 技能：
              // 十个工具都不在场，再让模型读到「怎么写工作流脚本」只会诱导它去调不存在的工具。
              ...(runtimeConfig.dynamicWorkflowEnabled === false
                ? collectDynamicWorkflowDisabledSkillPaths(bundledSkillRoots)
                : []),
            ],
          }))
        : undefined,
    mcpPort,
    eventSink: options.eventSink,
    modelFactory,
    modelIoDir,
    providerRuntimeHeadersPort: options.providerRuntimeHeadersPort,
    resolveEffectiveModelSelection: options.resolveEffectiveModelSelection,
    isRemoteWorkspace: () =>
      isRemoteWorkspaceIdentity(runtimeConfig.memory?.workspaceIdentity ?? ""),
    permissionBroker: options.permissionBroker,
    permissionService,
    workflowPort: scriptWorkflowFacade.workflowPort,
    dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort,
    modelCatalogPort,
    automationPort: options.automationPort,
    offPeakPort: options.offPeakPort,
    topicResourcePort: options.topicResourcePort,
    appVersion,
    traceContext,
  });
  return runtime;
}
