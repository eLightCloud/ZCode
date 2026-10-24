import { type SessionEvent, type ToolExecutionSpanWriter } from "@zcode/contracts";

import type {
  ExecutionShellSelection,
  SkillTelemetryMetadata,
  TraceContext,
  TraceId,
  TurnId,
} from "@zcode/contracts";

import type { ToolExecutionContext, ToolExecutionResult } from "../types.js";

import { createToolModelStatusSink, withDefaultToolModelStatusSink } from "./model-status-sink.js";

import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";

import type { ExecutableToolCall } from "../types.js";

import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";

export function createToolHandlerContext(
  options: ToolExecuteOptions | undefined,
  deps: ToolExecutorDeps,
  canonicalToolCall: ExecutableToolCall,
  telemetry: ToolExecutionSpanWriter | undefined,
  traceContext: TraceContext,
  traceId: TraceId,
  executionAbortController: AbortController,
  emitEvent: ((event: SessionEvent) => Promise<void>) | undefined,
  turnId: TurnId | undefined,
  handlerState: {
    readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];
    skillTelemetryMetadata: SkillTelemetryMetadata | undefined;
    failureStage: "handler" | "serialize" | "post_hook";
  },
  bashShellSelection: ExecutionShellSelection | undefined,
  guardedWorkingDirectory: string | undefined,
  inputAdjustments: Readonly<Record<string, unknown>> | undefined,
) {
  const model = options?.model ?? deps.model;
  const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
    bashAvailable: deps.registry.has("Bash"),
  });
  const context: ToolExecutionContext = {
    toolCallId: canonicalToolCall.id,
    toolSearch: options?.toolSearch,
    telemetry,
    automationTurn: options?.automationTurn,
    offPeakTurn: options?.offPeakTurn,
    traceContext,
    traceId,
    spanId: traceContext.spanId,
    parentSpanId: traceContext.parentSpanId,
    abortSignal: executionAbortController.signal,
    backgroundTaskControlPort: deps.backgroundTaskControlPort,
    emitEvent,
    executionPort: deps.executionPort,
    browserControlPort: deps.browserControlPort,
    browserDocumentationRoot: deps.browserDocumentationRoot,
    fileSystemPort: deps.fileSystemPort,
    httpClientPort: deps.httpClientPort,
    imageProcessorPort: deps.imageProcessorPort,
    pdfDocumentPort: deps.pdfDocumentPort,
    // 工具内部的模型请求默认把状态事件发进会话：deadline 暂停与 driver 相位都靠这条流。
    model: withDefaultToolModelStatusSink(
      model,
      createToolModelStatusSink({ emitEvent, sessionId: deps.sessionId, turnId, traceId }),
    ),
    subagentModelOverride: options?.subagentModelOverride,
    embeddedSearch: {
      ...(deps.embeddedSearchBackend ? { backend: deps.embeddedSearchBackend } : {}),
      enabled: embeddedSearchDecision?.useEmbeddedSearchBranch ?? false,
      ...(deps.nativeSearchEnhancementsEnabled === false ? { findAndGrepEnabled: false } : {}),
    },
    skillPort: deps.skillPort,
    subagentPort: deps.subagentPort,
    coordinatorResponsePort: deps.coordinatorResponsePort,
    workflowSubmitPort: deps.workflowSubmitPort,
    workflowEscalatePort: deps.workflowEscalatePort,
    artifactStore: deps.artifactStore,
    deliverableStore: deps.deliverableStore,
    getProducerContextRef: deps.getProducerContextRef,
    automationPort: deps.automationPort,
    offPeakPort: deps.offPeakPort,
    topicResourcePort: deps.topicResourcePort,
    sessionStore: deps.sessionStore,
    sessionModePort: deps.sessionModePort,
    workflowPort: deps.workflowPort,
    dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
    modelCatalogPort: deps.modelCatalogPort,
    runtimeTaskRegistry: deps.runtimeTaskRegistry,
    readFileState: deps.readFileState,
    recordReadFileStateMetadata: (metadata) => {
      handlerState.readFileStateMetadata = metadata;
    },
    recordSkillTelemetryMetadata: (metadata) => {
      handlerState.skillTelemetryMetadata = metadata;
    },
    bashShellSelection,
    setWorkingDirectory: deps.setWorkingDirectory,
    workingDirectory: guardedWorkingDirectory ?? deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
    workspaceIdentity: deps.workspaceIdentity,
    remoteSessionId: deps.remoteSessionId,
    clientMode: deps.clientMode,
    deliveryKind: deps.deliveryKind,
    memoryRoot: deps.getMemoryRoot?.(),
    runtimeScope: deps.runtimeScope,
    providerVisibleToolNames: deps.registry
      .list()
      .filter((name) => deps.registry.getMetadata(name)?.providerVisible !== false),
    sessionId: deps.sessionId,
    turnId,
    ...(inputAdjustments === undefined ? {} : { inputAdjustments }),
  };
  return context;
}
