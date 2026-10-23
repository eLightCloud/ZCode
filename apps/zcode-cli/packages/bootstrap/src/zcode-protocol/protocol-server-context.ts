import type { ZCodeProtocolAgentServer } from "./server.js";

/** 同一 owner 的内部类型视图；不复制状态，不暴露到端口。 */
export interface ZCodeProtocolAgentServerMethodsContext {
  readonly networkCapture: ZCodeProtocolAgentServer["networkCapture"];
  readonly runtimeResources: ZCodeProtocolAgentServer["runtimeResources"];
  shutdownPromise: ZCodeProtocolAgentServer["shutdownPromise"];
  readonly browserControlPort: ZCodeProtocolAgentServer["browserControlPort"];
  requestMcpElicitation: ZCodeProtocolAgentServer["requestMcpElicitation"];
  handleMcpNotification: ZCodeProtocolAgentServer["handleMcpNotification"];
  officialMcpAuthRequestContext: ZCodeProtocolAgentServer["officialMcpAuthRequestContext"];
  messageSink: ZCodeProtocolAgentServer["messageSink"];
  clientDisconnectError: ZCodeProtocolAgentServer["clientDisconnectError"];
  readonly context: ZCodeProtocolAgentServer["context"];
  readonly logger: ZCodeProtocolAgentServer["logger"];
  readonly pendingClientRequests: ZCodeProtocolAgentServer["pendingClientRequests"];
  readonly pluginOperationControllers: ZCodeProtocolAgentServer["pluginOperationControllers"];
  readonly workspaceGenerateTextControllers: ZCodeProtocolAgentServer["workspaceGenerateTextControllers"];
  readonly postResponseOutbox: ZCodeProtocolAgentServer["postResponseOutbox"];
  nextClientRequestId: ZCodeProtocolAgentServer["nextClientRequestId"];
  rebalanceResidentSessions: ZCodeProtocolAgentServer["rebalanceResidentSessions"];
  pruneSessionEventStores: ZCodeProtocolAgentServer["pruneSessionEventStores"];
  pruneDetachedChildPublishers: ZCodeProtocolAgentServer["pruneDetachedChildPublishers"];
  collectMemoryDiagnostics: ZCodeProtocolAgentServer["collectMemoryDiagnostics"];
  setNotificationSink: ZCodeProtocolAgentServer["setNotificationSink"];
  disconnectClient: ZCodeProtocolAgentServer["disconnectClient"];
  shutdown: ZCodeProtocolAgentServer["shutdown"];
  disposeProjections: ZCodeProtocolAgentServer["disposeProjections"];
  takePostResponseMessages: ZCodeProtocolAgentServer["takePostResponseMessages"];
  takePostResponseBatch: ZCodeProtocolAgentServer["takePostResponseBatch"];
  clearPostResponseMessages: ZCodeProtocolAgentServer["clearPostResponseMessages"];
  handleMessage: ZCodeProtocolAgentServer["handleMessage"];
  handleRequest: ZCodeProtocolAgentServer["handleRequest"];
  dispatchRequest: ZCodeProtocolAgentServer["dispatchRequest"];
  requireV4Gateway: ZCodeProtocolAgentServer["requireV4Gateway"];
  withPluginOperationSignal: ZCodeProtocolAgentServer["withPluginOperationSignal"];
  cancelPluginOperation: ZCodeProtocolAgentServer["cancelPluginOperation"];
  withWorkspaceGenerateTextSignal: ZCodeProtocolAgentServer["withWorkspaceGenerateTextSignal"];
  cancelWorkspaceGenerateText: ZCodeProtocolAgentServer["cancelWorkspaceGenerateText"];
  ok: ZCodeProtocolAgentServer["ok"];
  fail: ZCodeProtocolAgentServer["fail"];
  requestClient: ZCodeProtocolAgentServer["requestClient"];
  resolveClientRequest: ZCodeProtocolAgentServer["resolveClientRequest"];
  rejectClientRequest: ZCodeProtocolAgentServer["rejectClientRequest"];
  cleanupClientRequest: ZCodeProtocolAgentServer["cleanupClientRequest"];
}
