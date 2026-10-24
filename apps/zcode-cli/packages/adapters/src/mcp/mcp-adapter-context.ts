import type { Logger } from "@zcode/contracts";
import type { McpElicitationPort } from "@zcode/contracts";
import type { McpElicitationTrace } from "@zcode/contracts";
import type { McpNotificationPort } from "@zcode/contracts";
import type { McpServerStatus } from "@zcode/contracts";
import type { OfficialMcpAuthFailureKind } from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import type { NetworkEgressEnvPolicy } from "./network.js";
import type { McpOAuthRuntimeOptions } from "./oauth-provider-support.js";
import type { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";
import type { McpTelemetryTracker } from "./telemetry.js";
import type { CreateMcpAdapterOptions } from "./mcp-adapter-contract.js";
import type { McpServerRecord } from "./mcp-adapter-contract.js";
import type { McpToolCallResult } from "@zcode/contracts";
import type { McpToolDescriptor } from "@zcode/contracts";
import type { McpConnectOptions } from "@zcode/contracts";
import type { McpServerConfig } from "@zcode/contracts";
import type { McpServerFailureKind } from "@zcode/shared";
import type { McpClient } from "./mcp-adapter-contract.js";
import type { McpTransport } from "./mcp-adapter-contract.js";
import type { McpConnectionContext } from "./pool-contract.js";
import type { AuthProvider } from "@modelcontextprotocol/client";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import type { InteractiveAuthorizationTrigger } from "./oauth-errors.js";
import type { McpInteractiveAuthorizationOutcome } from "./oauth-interactive.js";
import type { AuthorizationCodeOAuthConfig } from "./mcp-adapter-contract.js";
import type { McpCallToolRequest } from "@zcode/contracts";
import type { McpCallToolOptions } from "@zcode/contracts";
import type { McpDeadline } from "./timeout.js";
import type { OfficialMcpAuthMetaPayload } from "./mcp-adapter-contract.js";
import type { OfficialMcpServerResponseInfo } from "./official-auth.js";

/** 唯一 owner 的内部状态 / 协作合同；不从实现反向取型，不创建副本。 */
export interface NodeMcpAdapterContext {
  readonly activeCallTraces: Map<string, McpElicitationTrace>;
  readonly adapterInstanceId: string;
  readonly appConnectionListeners: Map<string, Set<() => void>>;
  appConnectionSnapshot(name: string): { identity: string; generation: number } | null;
  attachStdioLogging(name: string, transport: McpTransport): () => string | undefined;
  callToolOnClient(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
  ): Promise<McpToolCallResult>;
  callToolOnClientInner(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
  ): Promise<McpToolCallResult>;
  readonly clientName: string;
  readonly clientVersion: string;
  closeClientAndTransport(
    name: string,
    client?: McpClient,
    transport?: McpTransport,
  ): Promise<void>;
  closeRecord(name: string): Promise<void>;
  connectServer(
    name: string,
    config: McpServerConfig,
    options?: McpConnectOptions,
  ): Promise<McpServerStatus>;
  readonly connectionContext: McpConnectionContext | undefined;
  readonly connectionDiagnosticByServer: Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >;
  readonly connectionGenerations: Map<string, number>;
  createAuthorizationCodeOAuthOptions(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    oauthAuthorizationTimeoutMs?: number,
  ): McpOAuthRuntimeOptions | undefined;
  createOAuthClientProvider(
    serverName: string,
    config: McpServerConfig,
  ): AuthProvider | OAuthClientProvider | undefined;
  createOfficialAuthFetch(
    config: McpServerConfig,
    serverName: string,
    generation: number,
  ): typeof globalThis.fetch | undefined;
  createStatus(
    config: McpServerConfig,
    status: McpServerStatus["status"],
    extra?: {
      authorization?: McpServerStatus["authorization"];
      error?: string;
      failureKind?: McpServerStatus["failureKind"];
      protocolEra?: McpServerStatus["protocolEra"];
      serverRequestId?: string;
      toolCount?: number;
    },
  ): McpServerStatus;
  createTransport(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    _oauthAuthorizationTimeoutMs?: number,
    workingDirectory?: string,
    signal?: AbortSignal,
  ): Promise<{ transport: McpTransport }>;
  credentialStore: SharedZCodeCredentialStore | undefined;
  disconnectServer(name: string): Promise<McpServerStatus | undefined>;
  readonly elicitation: McpElicitationPort | undefined;
  ensureToolCallAuthorizationRecovery(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    record: McpServerRecord;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus>;
  readonly env: NodeJS.ProcessEnv | undefined;
  failConnection(input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  }): Promise<McpServerStatus>;
  installElicitationHandler(client: McpClient, serverName: string): void;
  installNotificationHandlers(client: McpClient, serverName: string): void;
  isCurrentConnection(name: string, generation: number): boolean;
  readonly lastOfficialAuthKind: Map<string, OfficialMcpAuthFailureKind>;
  listTools(): Promise<McpToolDescriptor[]>;
  readonly logger: Logger | undefined;
  readonly mcpOAuth: McpOAuthRuntimeOptions | undefined;
  readonly network: NetworkEgressEnvPolicy | undefined;
  nextConnectionGeneration(name: string): number;
  readonly notifications: McpNotificationPort | undefined;
  readonly officialMcpAuth: CreateMcpAdapterOptions["officialMcpAuth"] | undefined;
  openServerConnection(input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    oauthAuthorizationTimeoutMs?: number;
    signal: AbortSignal;
    timeoutMs: number;
    workingDirectory?: string;
    oauthAuthorizationAttempted?: boolean;
  }): Promise<McpServerStatus>;
  reconnectForCall(name: string, config: McpServerConfig): Promise<void>;
  readonly records: Map<string, McpServerRecord>;
  recoverToolCallAuthorization(input: {
    deadline: McpDeadline;
    error: unknown;
    record: McpServerRecord;
    request: McpCallToolRequest;
    signal?: AbortSignal;
    onProgress?: McpCallToolOptions["onProgress"];
    timeoutMessage: string;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpToolCallResult>;
  rememberServerResponse(serverName: string, response: OfficialMcpServerResponseInfo): void;
  replayResourceSubscriptions(serverName: string, client: McpClient): Promise<void>;
  resolveConnectedRecord(
    serverName: string,
    deadline: McpDeadline,
    timeoutMessage: string,
    signal: AbortSignal | undefined,
  ): Promise<McpServerRecord & { client: McpClient }>;
  resolveCredentialStore(): SharedZCodeCredentialStore;
  resolveForResourceRequest(
    serverName: string,
    operation: string,
    options: McpCallToolOptions,
  ): Promise<{
    record: McpServerRecord & { client: McpClient };
    deadline: McpDeadline;
    timeoutMessage: string;
  }>;
  resolveOfficialStdioAuthMeta(
    serverName: string,
    config: McpServerConfig,
    signal: AbortSignal | undefined,
  ): Promise<OfficialMcpAuthMetaPayload | undefined>;
  readonly resourceSubscriptions: McpResourceSubscriptionRegistry;
  runInteractiveOAuthAuthorization(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpInteractiveAuthorizationOutcome>;
  runToolCallAuthorizationRecovery(input: {
    abortController: AbortController;
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    previousClient?: McpClient;
    previousTransport?: McpTransport;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus>;
  readonly serverRequestIdBySpan: Map<string, string>;
  status(): Promise<Record<string, McpServerStatus>>;
  takeServerRequestId(spanId: string | undefined): string | undefined;
  readonly telemetry: McpTelemetryTracker | undefined;
  terminateStdioProcessTree(name: string, transport?: McpTransport): Promise<void>;
  toolListRevisionCounter: number;
  unsubscribeOnServer(serverName: string, uri: string, options: McpCallToolOptions): Promise<void>;
  updateCurrentRecord(
    name: string,
    generation: number,
    patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
  ): void;
  updateCurrentRecordStatus(
    name: string,
    generation: number,
    patch: Partial<McpServerStatus>,
  ): void;
  waitForSharedConnection(
    name: string,
    record: McpServerRecord,
    options: McpConnectOptions,
  ): Promise<McpServerStatus>;
  readonly workingDirectory: string | undefined;
}
