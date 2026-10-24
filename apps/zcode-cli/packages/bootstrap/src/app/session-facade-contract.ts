import type { ConfigResult } from "@zcode/adapters/config";
import type { ExecutionPort } from "@zcode/contracts";
import type { LocalSettingStorePort } from "@zcode/contracts";
import type { Logger } from "@zcode/contracts";
import type { LoggerFactory } from "@zcode/contracts";
import type { McpPort } from "@zcode/contracts";
import type { McpServerConfig } from "@zcode/contracts";
import type { ProjectId } from "@zcode/contracts";
import type { SessionId } from "@zcode/contracts";
import type { SessionStorePort } from "@zcode/contracts";
import type { SupportedLocale } from "@zcode/contracts";
import type { TraceContext } from "@zcode/contracts";
import type { UiLocale } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type { ModelSelection } from "@zcode/provider";
import type { ProviderRegistryModelSource } from "./provider-registry-source.js";
import type { PrepareUserExecutionBoundary } from "./app-option-types.js";
import type { ZCodeApp } from "./types.js";
import type { CliDefaultSelection } from "./cli-default-selection.js";

export type SessionFacade = Pick<
  ZCodeApp,
  | "readBackgroundBashOutput"
  | "cancelBackgroundTask"
  | "clearTarget"
  | "close"
  | "callMcpToolForUi"
  | "getMcpAppConnectionSnapshot"
  | "waitForMcpAppConnection"
  | "onMcpAppConnectionInvalidated"
  | "replaceMcpAppProvidedTools"
  | "connectMcpServer"
  | "disconnectMcpServer"
  | "generateWorkspaceText"
  | "sampleModel"
  | "testModelConnectivity"
  | "forkFromCheckpoint"
  | "getMode"
  | "getModel"
  | "getCurrentModelOption"
  | "getModelOption"
  | "getLocale"
  | "getDefaultThoughtLevel"
  | "getThoughtLevel"
  | "getTheme"
  | "listCheckpoints"
  | "listMcpServers"
  | "getMcpToolVisibility"
  | "listModels"
  | "listThoughtLevels"
  | "loadSessionTranscript"
  | "readMcpResource"
  | "readMcpResourceForUi"
  | "listMcpResourcesForUi"
  | "listMcpResourceTemplatesForUi"
  | "subscribeMcpResourceForUi"
  | "unsubscribeMcpResourceForUi"
  | "unsubscribeMcpResourcesForUi"
  | "readSubagents"
  | "readSubagentTranscript"
  | "readTodos"
  | "readTarget"
  | "setCustomSessionTitle"
  | "setMode"
  | "setModel"
  | "setThoughtLevel"
  | "setLocale"
  | "setTarget"
  | "updateTargetStatus"
>;

export interface SessionResourceCloseInput {
  beginShutdown: () => void;
  closeBrowserSession: () => Promise<void>;
  closeExecution?: () => Promise<void> | void;
  closeMcp?: () => Promise<void> | void;
  closeNodeReplBrowserBroker?: () => Promise<void> | void;
  closeSessionStore?: () => void;
  logger: Logger;
  timeoutMs?: number;
}

export interface CreateSessionFacadeDeps {
  cliDefaultSelection?: CliDefaultSelection;
  /**
   * 停下本会话拥有的 dwf run：
   * run service 的 `close()`。缺席即本装配没有 dwf 端口（journal 窄化失败、测试装配）。
   */
  closeDynamicWorkflowRuns?: () => Promise<void>;
  closeNodeReplBrowserBroker?: () => Promise<void> | undefined;
  configResult: ConfigResult;
  configuredMcpServers: Record<string, McpServerConfig>;
  configuredDefaultModelSelection?: ModelSelection;
  executionPort: ExecutionPort;
  localSettingStore?: LocalSettingStorePort;
  logger: Logger;
  loggerFactory: LoggerFactory;
  mcpPort?: McpPort;
  ownsExecutionPort: boolean;
  ownsMcpPort: boolean;
  ownsSessionStore: boolean;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  prepareResume(traceContext?: TraceContext): Promise<void>;
  projectID: ProjectId;
  providerRegistry: ProviderRegistryModelSource;
  resolveUiLocale(locale: UiLocale): SupportedLocale;
  runtime: AgentRuntime;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  traceContext: TraceContext;
  untrustedProjectMcpServers: Set<string>;
  workingDirectory: string;
}
