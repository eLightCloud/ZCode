import { join } from "node:path";
import { AgentRuntime } from "@zcode/core";
import { buildPluginReferenceCatalog } from "@zcode/core";
import type { ResumeSessionResult } from "@zcode/core";
import type { TraceContext } from "@zcode/contracts";
import { createModelAdapter } from "../model-factory.js";
import { scheduleStartupLogRetentionCleanup } from "../log-retention.js";
import type { PrepareUserExecutionBoundary } from "./app-option-types.js";
import type { ResumeOptions } from "./app-option-types.js";
import type { ZCodeApp } from "./types.js";
import type { ZCodeAppOptions } from "./app-option-types.js";
import { projectIdFromDirectory } from "./paths.js";
import { asLocalSettingStore } from "./session-store.js";
import { openStartupSessionStore } from "./session-store.js";
import { readProjectPermissionMode } from "./session-store.js";
import { createPluginFacadeForApp } from "./plugin-facade.js";
import { resolveAppRuntimeConfig } from "./runtime-config.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
import { createDynamicWorkflowSnippetService } from "./dynamic-workflow-snippet-service.js";
import { createModelCatalogPort } from "./model-catalog-port.js";
import type { NodeReplBrowserBroker } from "./browser-broker-port.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../model-config.js";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import { completeAppStartup } from "./startup-marks.js";
import { markRuntimeConstructed } from "./startup-marks.js";
import { resolveAppStartupSources } from "./app-startup-sources.js";
import { createAppHookSecurity } from "./app-hook-security-assembly.js";
import { createAppInfrastructure } from "./app-infrastructure.js";
import { createAppResumeBoundary } from "./app-resume-boundary.js";
import { createAppWorkflowRuntime } from "./app-workflow-assembly.js";
import { createAppAgentRuntime } from "./app-agent-assembly.js";
import { createAppFacades } from "./app-facade-assembly.js";
import { createAppHookReviewFacade } from "./app-hook-review-facade.js";
import { createAppAttachmentFacade } from "./app-attachment-facade.js";
import { createAppWorkflowJournalFacade } from "./app-workflow-journal-facade.js";
import { createAppStartupContext } from "./app-startup-context.js";
import { configureAppBrowserResources } from "./app-browser-resources.js";
import { CliDefaultSelection } from "./cli-default-selection.js";

export async function createZCodeApp(options: ZCodeAppOptions): Promise<ZCodeApp> {
  const {
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
  } = createAppStartupContext(options);
  const browserResources: {
    nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
    ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  } = { nodeReplBrowserBroker: undefined, ownedNodeReplBrowserBroker: undefined };

  let providerModelRuntime: ApiProviderModelRuntime | undefined;
  try {
    const {
      cliStorageRoot,
      pluginOutcome,
      builtInMcpServers,
      pluginRuntimeFeatures,
      zcodeSubagentProfileOutcome,
      subagentProfiles,
      storageRoot,
      modelIoDir,
      pluginTemplates,
      bundledSkillRoots,
    } = await resolveAppStartupSources(
      configResult,
      options,
      traceContext,
      logger,
      workingDirectory,
      startupTimer,
    );
    const ownsSessionStore = options.sessionStore === undefined;
    const sessionStore =
      options.sessionStore ?? (await openStartupSessionStore(configResult, startupTimer));
    const localSettingStore = asLocalSettingStore(sessionStore);
    const projectID = projectIdFromDirectory(workingDirectory);
    const persistedMode = options.runtimeConfig?.mode
      ? undefined
      : readProjectPermissionMode(localSettingStore, projectID);
    let { configuredMcpServers, runtimeConfig, untrustedProjectMcpServers } =
      resolveAppRuntimeConfig({
        cliStorageRoot,
        configResult,
        options,
        persistedMode,
        pluginHooks: pluginOutcome.hooks,
        pluginMcpServers: pluginOutcome.mcpServers,
        builtInMcpServers,
        pluginRuntimeFeatures,
        builtInSubagentModelSelectionOverrides:
          zcodeSubagentProfileOutcome.builtInModelSelectionOverrides,
        subagentOutputRootDir: join(cliStorageRoot, "agents"),
        subagentProfiles,
        storageRoot,
        workingDirectory,
        workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      });
    let browserControlPort;
    ({ browserControlPort, configuredMcpServers } = configureAppBrowserResources(
      options,
      pluginRuntimeFeatures,
      runtimeConfig,
      browserResources,
      logger,
      configuredMcpServers,
      startupTimer,
      workingDirectory,
    ));
    // Plugin 对话引用：身份 catalog 在 App（Session runtime）
    // 创建时冻结一次。冷恢复会重建 App，天然拿到新 catalog；已有 Session 不热加载新 Plugin。
    const pluginReferenceCatalog = buildPluginReferenceCatalog(pluginOutcome.plugins);
    runtimeConfig.pluginReferenceCatalog = pluginReferenceCatalog;
    let runtime: AgentRuntime | undefined;
    const cliDefaultSelection =
      options.modelSelectionMode === "cli-default"
        ? new CliDefaultSelection(runtimeConfig.modelSelection)
        : undefined;
    const getRuntime = (): AgentRuntime => {
      if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
      return runtime;
    };
    const workspaceHookRuntimeSecurity = createAppHookSecurity(
      appVersion,
      logger,
      options,
      configResult,
      runtimeConfig,
      sessionId,
      workingDirectory,
      getRuntime,
      traceContext,
    );
    const {
      providerEndpointRoutingPort,
      artifactStore,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      mcpPort,
      permissionService,
      executionPort,
      sessionMailboxPort,
      deliverableStore,
      inputHistoryStore,
      ownsExecutionPort,
      ownsMcpPort,
    } = createAppInfrastructure(
      configResult,
      options,
      sessionStore,
      storageRoot,
      logger,
      cliStorageRoot,
      startupTimer,
      runtimeConfig,
      workingDirectory,
      appVersion,
      configuredMcpServers,
    );
    const {
      prepareUserExecutionBoundary,
      prepareResume,
      resumeFromStore,
    }: {
      prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
      prepareResume: (
        submitTraceContext?: TraceContext,
        abortSignal?: AbortSignal,
      ) => Promise<void>;
      resumeFromStore: (resumeOptions?: ResumeOptions) => Promise<ResumeSessionResult>;
    } = createAppResumeBoundary(
      options,
      getRuntime,
      sessionStore,
      sessionId,
      logger,
      traceContext,
      cliDefaultSelection,
    );

    const modelExecutionConfig = createRuntimeAiSdkModelExecutionConfig(options.env, {
      appVersion,
      endpointRoutingPort: providerEndpointRoutingPort,
      network: configResult.config.network,
      sourceTitle: options.sourceTitle,
    });
    const modelAdapter =
      options.modelAdapter ??
      createModelAdapter({
        env: options.env,
        logger: modelLogger,
        modelIoDir,
        modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
        executionConfig: modelExecutionConfig,
        statusSink: modelTelemetry.statusSink,
        streamIdleTimeoutMs: configResult.config.modelStream.idleTimeoutMs,
      });
    if (options.modelAdapter && modelTelemetry.statusSink) {
      modelAdapter.addStatusSink(modelTelemetry.statusSink);
    }
    // 进程级并发治理器：run service 拿它的窄端口给
    // driver（每个 actor runtime 一个请求级准入端口）；主 runtime 挂它的 observer（下面 deps）——
    // 不排队、不看冷却，但计入在飞并喂信号。进程级单例——配额本就在账号上，不按会话分。
    // 不再经 adapter 级 addStatusSink 喂信号：同一事件只能沿 ticket 喂一次。
    const workflowConcurrencyGovernor = getWorkflowConcurrencyGovernor();
    modelAdapter.setModelIoFullRetentionEnabled(options.modelIoFullRetentionEnabled ?? false);
    providerModelRuntime = new ApiProviderModelRuntime({
      registry: options.providerRegistry,
      modelAdapter,
    });
    providerModelRuntime.start();
    // model factory 提前到三条 workflow child 装配线之前构造：script workflow bridge、dwf actor
    // runtime 与 expert workflow facade 都**共享**父会话这一份 factory——Registry 视图更新后
    // 新建的 Model 才看得到，child 不各自冻结一份。
    const modelFactory = providerModelRuntime.modelFactory;
    const scriptWorkflowFacade = createScriptWorkflowBridge({
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: options,
      appVersion,
      artifactStore,
      configResult,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      pluginSkillRoots: pluginOutcome.skillRoots,
      prepareUserExecutionBoundary,
      getRuntime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });

    // workflow run service：CreateWorkflow 的确认窗 Allow 之后真启动引擎的那一侧。
    // journal 窄化失败（store 不带 dwf_* 表）时**不构造**服务——端口保持 undefined，
    // CreateWorkflow 因此回到占位诊断路径。这是一个记了日志的可见降级，而不是一条
    // 会静默丢掉持久化的运行路径（详见 dynamic-workflow-run-service.ts 的文件头）。
    const dynamicWorkflowRunPort = createAppWorkflowRuntime(
      sessionStore,
      logger,
      workflowConcurrencyGovernor,
      getRuntime,
      modelTelemetry,
      options,
      appVersion,
      artifactStore,
      configResult,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      mcpPort,
      modelFactory,
      permissionService,
      pluginOutcome,
      runtimeConfig,
      sessionId,
      storageRoot,
      workingDirectory,
      browserControlPort,
      traceContext,
      executionPort,
    );
    // dwf snippet service：EvalWorkflowSnippet 的执行面。刻意**不**依赖 dwf journal——
    // snippet 完全瞬态（内存 journal），不该被 run service 的 durability 前提连坐；
    // 所以即使 run 端口因 journal 缺席而不构造，实验通道仍然可用。
    const dynamicWorkflowSnippetPort = createDynamicWorkflowSnippetService({
      executionPort,
      fileSystemPort,
      logger,
    });
    // 模型目录：工具层把用户说的模型名解析成 workflow run 的子代理选型（model-catalog-port.ts）。
    const modelCatalogPort = createModelCatalogPort({
      registry: options.providerRegistry,
      currentSelection: () => getRuntime().getSessionModelSelection(),
    });
    runtime = createAppAgentRuntime(
      runtime,
      sessionId,
      runtimeConfig,
      options,
      logger,
      pluginOutcome,
      pluginTemplates,
      modelTelemetry,
      workflowConcurrencyGovernor,
      sessionStore,
      sessionMailboxPort,
      executionPort,
      workspaceHookRuntimeSecurity,
      browserControlPort,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      artifactStore,
      deliverableStore,
      configResult,
      workingDirectory,
      cliStorageRoot,
      startupTimer,
      bundledSkillRoots,
      mcpPort,
      modelFactory,
      modelIoDir,
      permissionService,
      scriptWorkflowFacade,
      dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort,
      modelCatalogPort,
      appVersion,
      traceContext,
    );
    markRuntimeConstructed({
      hasInjectedModelAdapter: options.modelAdapter !== undefined,
      sessionId,
      startupTimer,
    });
    completeAppStartup({
      sessionId,
      startupTimer,
      workingDirectory,
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    const { sessionFacade, workflowFacade, inputFacade } = createAppFacades(
      artifactStore,
      runtimeConfig,
      workingDirectory,
      runtime,
      traceContext,
      options,
      executionPort,
      logger,
      sessionId,
      inputHistoryStore,
      prepareUserExecutionBoundary,
      modelTelemetry,
      appVersion,
      cliStorageRoot,
      configResult,
      imageProcessorPort,
      pdfDocumentPort,
      mcpPort,
      modelFactory,
      permissionService,
      sessionStore,
      storageRoot,
      dynamicWorkflowRunPort,
      configuredMcpServers,
      localSettingStore,
      loggerFactory,
      ownsExecutionPort,
      ownsMcpPort,
      browserResources.ownedNodeReplBrowserBroker,
      ownsSessionStore,
      prepareResume,
      projectID,
      untrustedProjectMcpServers,
      cliDefaultSelection,
    );

    const closeSession = sessionFacade.close;

    return {
      sessionId,
      traceId: traceContext.traceId,
      runtime,
      ...createAppHookReviewFacade(workspaceHookRuntimeSecurity),
      setModelIoFullRetentionEnabled: (enabled) =>
        modelAdapter.setModelIoFullRetentionEnabled(enabled),
      readToolResultArtifact: (uri) =>
        artifactStore.readToolResultArtifact({ uri, trace: traceContext }),
      ...createAppAttachmentFacade(
        artifactStore,
        sessionId,
        traceContext,
        sessionStore,
        fileSystemPort,
      ),
      ...sessionFacade,
      close: async () => {
        try {
          await closeSession?.();
        } finally {
          if (!options.deliverableStore) deliverableStore.close();
          try {
            providerModelRuntime?.dispose();
          } finally {
            await modelTelemetry.shutdown();
          }
        }
      },
      ...workflowFacade,
      ...scriptWorkflowFacade,
      ...createAppWorkflowJournalFacade(
        dynamicWorkflowRunPort,
        getRuntime,
        traceContext,
        prepareUserExecutionBoundary,
      ),

      ...createPluginFacadeForApp({ configResult, options, workingDirectory }),
      getPluginReferenceCatalog: () => pluginReferenceCatalog,
      getSkillCatalog: async () => {
        // Skill 目录属于 context 初始化结果。冷恢复必须先恢复 Session 边界，再读取
        // 新 runtime 的快照，不能绕开 resume 后用旧工作目录独立扫描。
        await prepareUserExecutionBoundary({ traceContext });
        return await getRuntime().getSkillCatalog(traceContext);
      },
      resume: resumeFromStore,
      ...inputFacade,
    };
  } catch (error) {
    providerModelRuntime?.dispose();
    void modelTelemetry.shutdown().catch(() => undefined);
    void browserResources.ownedNodeReplBrowserBroker?.close();
    startupTimer.fail("ZCode app startup failed", error, {
      context: { sessionId, workingDirectory },
      event: "bootstrap.app.startup.failed",
      stage: "total",
    });
    throw error;
  }
}
