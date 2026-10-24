import { queryNativeDeliverables } from "./deliverables.js";
import { subscribeConversationTopic } from "./protocol-v4-subscription.js";
import { querySessionDebug } from "./session-debug.js";
import { zcodeProtocolMethods } from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { V4_NOTIFICATIONS } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeProtocolRequest } from "@zcode/shared";
import { cancelBackgroundTask } from "./server-operations.js";
import { closeSession } from "./server-operations.js";
import { compactSession } from "./server-operations.js";
import { createSession } from "./server-operations.js";
import { forkSession } from "./server-operations.js";
import { generateWorkspaceText } from "./server-operations.js";
import { getTaskTokenUsage } from "./server-operations.js";
import { getUsageStats } from "./server-operations.js";
import { goalSession } from "./server-operations.js";
import { listSessionSubagents } from "./server-operations.js";
import { listSessions } from "./server-operations.js";
import { readEvents } from "./server-operations.js";
import { readMessages } from "./server-operations.js";
import { readSession } from "./server-operations.js";
import { resumeSession } from "./server-operations.js";
import { sendPrompt } from "./server-operations.js";
import { setMode } from "./server-operations.js";
import { setModel } from "./server-operations.js";
import { setThoughtLevel } from "./server-operations.js";
import { stopSession } from "./server-operations.js";
import { subscribeSession } from "./server-operations.js";
import { listChildProcesses } from "./process-child-processes.js";
import { readWorkspacePresentation } from "./workspace-model-runtime.js";
import { testProviderModelConnectivity } from "./workspace-model-runtime.js";
import { addPluginMarketplace } from "./plugins.js";
import { configurePlugin } from "./plugins.js";
import { describePlugin } from "./plugins.js";
import { getPluginsOverview } from "./plugins.js";
import { installPlugin } from "./plugins.js";
import { listPlugins } from "./plugins.js";
import { removePluginMarketplace } from "./plugins.js";
import { resetPluginConfig } from "./plugins.js";
import { restoreBuiltinPlugin } from "./plugins.js";
import { setPluginEnabled } from "./plugins.js";
import { uninstallPlugin } from "./plugins.js";
import { updatePlugin } from "./plugins.js";
import { updatePluginMarketplace } from "./plugins.js";
import { validatePlugin } from "./plugins.js";
import { getPluginReferenceCatalog } from "./plugin-reference-catalog.js";
import { resolveSuggestedPluginReference } from "./plugin-reference-catalog.js";
import { getSkillReferenceCatalog } from "./skill-reference-catalog.js";
import { deleteSavedWorkflowOp } from "./saved-workflows.js";
import { getSavedWorkflowOp } from "./saved-workflows.js";
import { listSavedWorkflowRunsOp } from "./saved-workflows.js";
import { listSavedWorkflowsOp } from "./saved-workflows.js";
import { moveSavedWorkflowOp } from "./saved-workflows.js";
import { updateSavedWorkflowMetaOp } from "./saved-workflows.js";
import { findSavedWorkflowForRunOp } from "./saved-workflows-run.js";
import { saveSavedWorkflowFromRunOp } from "./saved-workflows-run.js";
import { listMcpServers } from "./mcp.js";
import { callMcpUiTool } from "./mcp-ui/index.js";
import { cancelMcpUiSampling } from "./mcp-ui/index.js";
import { cancelMcpUiToolCall } from "./mcp-ui/index.js";
import { claimMcpUiAppToolCall } from "./mcp-ui/index.js";
import { listMcpUiResourceTemplates } from "./mcp-ui/index.js";
import { listMcpUiResources } from "./mcp-ui/index.js";
import { readMcpUiResource } from "./mcp-ui/index.js";
import { readMcpUiResourceForUi } from "./mcp-ui/index.js";
import { registerMcpUiAppTools } from "./mcp-ui/index.js";
import { resolveMcpUiAppToolCall } from "./mcp-ui/index.js";
import { sampleMcpUi } from "./mcp-ui/index.js";
import { subscribeMcpUiResource } from "./mcp-ui/index.js";
import { unregisterMcpUiAppTools } from "./mcp-ui/index.js";
import { unsubscribeMcpUiResource } from "./mcp-ui/index.js";
import { listPluginUiSurfaces } from "./plugin-ui-surfaces.js";
import { updateInteractionPreferences } from "./interaction-preferences.js";
import { updateAccountProviderConfig } from "./account-provider-config.js";
import { updateModelIoPreferences } from "./model-io-preferences.js";
import { updateOffPeakToolPolicy } from "./off-peak-tool-policy.js";
import { updateDynamicWorkflowPolicy } from "./dynamic-workflow-policy.js";
import { grantWorkspaceHookTrustAndNotifySessions } from "./workspace-hook-trust.js";
import { ProtocolRequestError } from "./server-types.js";
import { closeMcpUiInstance } from "./mcp-ui/index.js";
import { openMcpUiInstance } from "./mcp-ui/index.js";
import { validateMcpUiInstance } from "./mcp-ui/index.js";
import type { ZCodeProtocolAgentServerMethodsContext } from "./protocol-server-context.js";
import { offPeakControlParamsSchema } from "@zcode/shared";
import { offPeakControlResultSchema } from "@zcode/shared";
import { refreshProviderRegistry } from "./account-provider-config.js";

export async function dispatchRequest(
  this: ZCodeProtocolAgentServerMethodsContext,
  request: ZCodeProtocolRequest,
) {
  switch (request.method) {
    case zcodeProtocolMethods.deliverablesList:
      return await queryNativeDeliverables("list", request.params);
    case zcodeProtocolMethods.deliverableRelease:
      return await queryNativeDeliverables("release", request.params);
    case zcodeProtocolMethods.deliverableRead:
      return await queryNativeDeliverables("read", request.params);
    // ── v4 conversation 通道（竖切，与旧 session/* 并存）──
    case V4_METHODS.connectionFlow: {
      this.requireV4Gateway().setConnectionFlowState(request.params);
      return {};
    }
    case V4_METHODS.conversationSubscribe:
      return await subscribeConversationTopic.call(this, request);
    case V4_METHODS.conversationResync: {
      // same-sub recovery 与 subscribe 共用确定性 post-response outbox；公共
      // response 仍 strict ACK-only，physical recovery 只能在 ACK line 后发送。
      const dispatch = this.requireV4Gateway().resyncReserved(request.params);
      if (dispatch.initialWires.length > 0) {
        this.postResponseOutbox.set(request.id, {
          messages: dispatch.initialWires.map((wire) => ({
            method: V4_NOTIFICATIONS.conversationFrame,
            params: wire,
          })),
          commit: dispatch.commit,
        });
      }
      return { ack: dispatch.ack };
    }
    case V4_METHODS.conversationUnsubscribe: {
      // topic + subscriptionId + connectionId 精确命中唯一 publisher；禁止按裸
      // subId 对 conversation/sessions-index/workspace-config 广撒网。
      this.requireV4Gateway().unsubscribe(request.params);
      return {};
    }
    // ── 行分页 query（独立分支，便于与帧分派改动合并）──
    case V4_METHODS.conversationRowsRange:
      return await this.requireV4Gateway().rowsRange(request.params);
    case V4_METHODS.conversationPlans:
      return await this.requireV4Gateway().plans(request.params);
    case V4_METHODS.backgroundBashOutput:
      return await this.requireV4Gateway().backgroundBashOutput(request.params);
    case V4_METHODS.offPeakControl: {
      const params = offPeakControlParamsSchema.parse(request.params);
      const record = this.context.sessions.get(params.sessionId);
      // 生命周期只存在于驻留 runtime；换票不能恢复冷会话或重放原始输入。
      return offPeakControlResultSchema.parse(
        record ? await record.app.runtime.controlOffPeakExecution(params) : { accepted: false },
      );
    }
    case V4_METHODS.conversationFileChanges:
      return await this.requireV4Gateway().fileChanges(request.params);
    case V4_METHODS.conversationFileRewindPreview:
      return await this.requireV4Gateway().fileRewindPreview(request.params);
    // workflow run 事件日志分页（只读、无状态、超时重发安全；新方法天然偏斜安全）。
    case V4_METHODS.conversationWorkflowRunEvents:
      return await this.requireV4Gateway().workflowRunEvents(request.params);
    // dwf run 枚举（重启后的发现查询）。
    case V4_METHODS.conversationWorkflowRuns:
      return await this.requireV4Gateway().workflowRuns(request.params);
    // dwf 用户面产物的三个读面。同族：只读、无状态、
    // 超时重发安全；ArtifactRead 的授权在宿主端口侧，网关只校参数与分块。
    case V4_METHODS.conversationWorkflowRunArtifacts:
      return await this.requireV4Gateway().workflowRunArtifacts(request.params);
    case V4_METHODS.conversationWorkflowRunArtifactData:
      return await this.requireV4Gateway().workflowRunArtifactData(request.params);
    case V4_METHODS.conversationWorkflowRunArtifactRead:
      return await this.requireV4Gateway().workflowRunArtifactRead(request.params);
    // dwf 工作区 transcript 的两个读面。同族。
    case V4_METHODS.conversationWorkflowRunWorkspace:
      return await this.requireV4Gateway().workflowRunWorkspace(request.params);
    case V4_METHODS.conversationWorkflowRunNodeResult:
      return await this.requireV4Gateway().workflowRunNodeResult(request.params);
    // 附件只能走小 RPC transaction，禁止 full-data attachment/put 单行。
    case V4_METHODS.attachmentBegin:
      return await this.requireV4Gateway().attachmentBegin(request.params);
    case V4_METHODS.attachmentChunk:
      return await this.requireV4Gateway().attachmentChunk(request.params);
    case V4_METHODS.attachmentCommit:
      return await this.requireV4Gateway().attachmentCommit(request.params);
    case V4_METHODS.attachmentAbort:
      await this.requireV4Gateway().attachmentAbort(request.params);
      return {};
    case V4_METHODS.attachmentRead:
      return await this.requireV4Gateway().attachmentRead(request.params);
    case V4_METHODS.conversationAttachmentRead:
      return await this.requireV4Gateway().conversationAttachmentRead(request.params);
    case V4_METHODS.conversationAttachmentStat:
      return await this.requireV4Gateway().conversationAttachmentStat(request.params);
    case V4_METHODS.attachmentPreviewSource:
      return await this.requireV4Gateway().attachmentPreviewSource(request.params);
    // ── usage query（additive）：与旧 usage/stats、session/usage 同一数据访问
    // 层（usage store 聚合），仅换 v4 名字空间——不经 v4Gateway（无会话投影依赖），
    // 也不经旧 op 分派（无桥）。旧 case 保留到旧词删除（老 host 版本兼容）。──
    case V4_METHODS.usageStats:
      return await getUsageStats(this.context, request.params);
    case V4_METHODS.conversationUsage:
      return await getTaskTokenUsage(this.context, request.params);
    case V4_METHODS.command:
      return this.requireV4Gateway().handleCommand(request.params);
    case V4_METHODS.commandsQuery:
      return this.requireV4Gateway().queryCommands(request.params);
    case V4_METHODS.sessionsIndexReconcile:
      return this.requireV4Gateway().reconcileSessions(request.params);
    case zcodeProtocolMethods.sessionCreate:
      return await createSession(this.context, request.params, request.trace);
    case zcodeProtocolMethods.sessionResume:
      return await resumeSession(this.context, request.params);
    case zcodeProtocolMethods.sessionList:
      return await listSessions(this.context, request.params);
    case zcodeProtocolMethods.sessionSubagents:
      return await listSessionSubagents(this.context, request.params);
    case zcodeProtocolMethods.sessionRead:
      return await readSession(this.context, request.params);
    case zcodeProtocolMethods.sessionMessages:
      return await readMessages(this.context, request.params);
    case zcodeProtocolMethods.sessionEvents:
      return await readEvents(this.context, request.params);
    case zcodeProtocolMethods.sessionSubscribe:
      return await subscribeSession(this.context, request.params);
    case zcodeProtocolMethods.sessionSend:
      return await sendPrompt(this.context, request.params);
    case zcodeProtocolMethods.sessionStop:
      return await stopSession(this.context, request.params);
    case zcodeProtocolMethods.sessionCancelBackgroundTask:
      return await cancelBackgroundTask(this.context, request.params);
    case zcodeProtocolMethods.sessionFork:
      return await forkSession(this.context, request.params);
    case zcodeProtocolMethods.sessionCompact:
      return await compactSession(this.context, request.params);
    case zcodeProtocolMethods.sessionGoal:
      return await goalSession(this.context, request.params);
    case zcodeProtocolMethods.sessionSetModel:
      return await setModel(this.context, request.params);
    case zcodeProtocolMethods.sessionSetThoughtLevel:
      return await setThoughtLevel(this.context, request.params);
    case zcodeProtocolMethods.sessionSetMode:
      return await setMode(this.context, request.params);
    case zcodeProtocolMethods.sessionClose:
      return await closeSession(this.context, request.params);
    case zcodeProtocolMethods.workspaceReadPresentation:
      return await readWorkspacePresentation(this.context, request.params);
    case zcodeProtocolMethods.workspaceHookTrustGrant:
      return await grantWorkspaceHookTrustAndNotifySessions(this.context, request.params);
    case zcodeProtocolMethods.providerUpdateAccountConfig:
      return await updateAccountProviderConfig(this.context, request.params);
    case zcodeProtocolMethods.providerRefreshRegistry:
      return await refreshProviderRegistry(this.context, request.params);
    case zcodeProtocolMethods.workspaceUpdateInteractionPreferences:
      return await updateInteractionPreferences(this.context, request.params);
    case zcodeProtocolMethods.workspaceUpdateModelIoPreferences:
      return await updateModelIoPreferences(this.context, request.params);
    case zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy:
      return await updateOffPeakToolPolicy(this.context, request.params);
    case zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy:
      return await updateDynamicWorkflowPolicy(this.context, request.params);
    case zcodeProtocolMethods.workspaceGenerateText:
      return await this.withWorkspaceGenerateTextSignal(request, (signal) =>
        generateWorkspaceText(this.context, request.params, signal),
      );
    case zcodeProtocolMethods.workspaceCancelGenerateText:
      return this.cancelWorkspaceGenerateText(request.params);
    case zcodeProtocolMethods.providerTestModelConnectivity:
      return await testProviderModelConnectivity(this.context, request.params);
    case zcodeProtocolMethods.mcpList:
      return await listMcpServers(this.context, request.params);
    case zcodeProtocolMethods.mcpReadResource:
      return await readMcpUiResource(this.context, request.params);
    case zcodeProtocolMethods.mcpUiOpenInstance:
      return openMcpUiInstance(this.context, request.params);
    case zcodeProtocolMethods.mcpUiValidateInstance:
      return validateMcpUiInstance(this.context, request.params);
    case zcodeProtocolMethods.mcpUiCloseInstance:
      return closeMcpUiInstance(this.context, request.params);
    case zcodeProtocolMethods.mcpUiSampling:
      return sampleMcpUi(this.context, request.params);
    case zcodeProtocolMethods.mcpUiCancelSampling:
      return cancelMcpUiSampling(this.context, request.params);
    case zcodeProtocolMethods.mcpUiCallTool:
      return await callMcpUiTool(this.context, request.params);
    case zcodeProtocolMethods.mcpUiCancelCall:
      return await cancelMcpUiToolCall(this.context, request.params);
    case zcodeProtocolMethods.mcpUiReadResource:
      return await readMcpUiResourceForUi(this.context, request.params);
    case zcodeProtocolMethods.mcpUiListResources:
      return await listMcpUiResources(this.context, request.params);
    case zcodeProtocolMethods.mcpUiListResourceTemplates:
      return await listMcpUiResourceTemplates(this.context, request.params);
    case zcodeProtocolMethods.mcpUiSubscribeResource:
      return await subscribeMcpUiResource(this.context, request.params);
    case zcodeProtocolMethods.mcpUiUnsubscribeResource:
      return await unsubscribeMcpUiResource(this.context, request.params);
    case zcodeProtocolMethods.mcpUiRegisterAppTools:
      return await registerMcpUiAppTools(this.context, request.params);
    case zcodeProtocolMethods.mcpUiUnregisterAppTools:
      return await unregisterMcpUiAppTools(this.context, request.params);
    case zcodeProtocolMethods.mcpUiClaimAppToolCall:
      return await claimMcpUiAppToolCall(this.context, request.params);
    case zcodeProtocolMethods.mcpUiResolveAppToolCall:
      return await resolveMcpUiAppToolCall(this.context, request.params);
    case zcodeProtocolMethods.pluginsList:
      return await listPlugins(this.context, request.params);
    case zcodeProtocolMethods.pluginsReferenceCatalogWithCategory:
      return await getPluginReferenceCatalog(this.context, request.params, true);
    case zcodeProtocolMethods.pluginsReferenceCatalog:
      return await getPluginReferenceCatalog(this.context, request.params);
    case zcodeProtocolMethods.pluginsListUiSurfaces:
      return await listPluginUiSurfaces(this.context, request.params);
    case zcodeProtocolMethods.skillsReferenceCatalog:
      return await getSkillReferenceCatalog(this.context, request.params);
    case zcodeProtocolMethods.workflowsList:
      return await listSavedWorkflowsOp(this.context, request.params);
    case zcodeProtocolMethods.workflowsGet:
      return await getSavedWorkflowOp(this.context, request.params);
    case zcodeProtocolMethods.workflowsUpdateMeta:
      return await updateSavedWorkflowMetaOp(this.context, request.params);
    case zcodeProtocolMethods.workflowsDelete:
      return await deleteSavedWorkflowOp(this.context, request.params);
    case zcodeProtocolMethods.workflowsRuns:
      return await listSavedWorkflowRunsOp(this.context, request.params);
    case zcodeProtocolMethods.workflowsMove:
      return await moveSavedWorkflowOp(this.context, request.params);
    case zcodeProtocolMethods.workflowsSave:
      return await saveSavedWorkflowFromRunOp(this.context, request.params);
    case zcodeProtocolMethods.workflowsForRun:
      return await findSavedWorkflowForRunOp(this.context, request.params);
    case zcodeProtocolMethods.pluginsResolveSuggestedReference:
      return await this.withPluginOperationSignal(request, (signal) =>
        resolveSuggestedPluginReference(this.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsSetEnabled:
      return await this.withPluginOperationSignal(request, (signal) =>
        setPluginEnabled(this.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsOverview:
      return await getPluginsOverview(this.context, request.params);
    case zcodeProtocolMethods.processChildProcesses:
      return listChildProcesses(this.context.deps.mcpTelemetry?.listProcesses() ?? []);
    case zcodeProtocolMethods.runtimeCapabilities:
      return { independentPlanState: true, historyFirst: true };
    case zcodeProtocolMethods.pluginsMarketplaceAdd:
      return await this.withPluginOperationSignal(request, (signal) =>
        addPluginMarketplace(this.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsMarketplaceRemove:
      return await removePluginMarketplace(this.context, request.params);
    case zcodeProtocolMethods.pluginsMarketplaceUpdate:
      return await this.withPluginOperationSignal(request, (signal) =>
        updatePluginMarketplace(this.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsInstall:
      return await this.withPluginOperationSignal(request, (signal) =>
        installPlugin(this.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsCancelOperation:
      return this.cancelPluginOperation(request.params);
    case zcodeProtocolMethods.pluginsUninstall:
      return await uninstallPlugin(this.context, request.params);
    case zcodeProtocolMethods.pluginsUpdate:
      return await updatePlugin(this.context, request.params);
    case zcodeProtocolMethods.pluginsRestoreBuiltin:
      return await restoreBuiltinPlugin(this.context, request.params);
    case zcodeProtocolMethods.pluginsConfigure:
      return await configurePlugin(this.context, request.params);
    case zcodeProtocolMethods.pluginsResetConfig:
      return await resetPluginConfig(this.context, request.params);
    case zcodeProtocolMethods.pluginsValidate:
      return await validatePlugin(this.context, request.params);
    case zcodeProtocolMethods.pluginsDescribe:
      return await describePlugin(this.context, request.params);
    case zcodeProtocolMethods.usageStats:
      return await getUsageStats(this.context, request.params);
    case zcodeProtocolMethods.sessionDebug:
      return querySessionDebug(this.context, request.params);
    case zcodeProtocolMethods.sessionUsage:
      return await getTaskTokenUsage(this.context, request.params);
    default:
      throw new ProtocolRequestError(-32601, `Method not found: ${request.method}`);
  }
}
