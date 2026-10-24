import type { createNodeNetworkCapture } from "@zcode/shared/node";
import type { BrowserControlPort } from "@zcode/contracts";
import type { ZCodeProtocolMethod } from "@zcode/shared";
import type { ZCodeProtocolRequest } from "@zcode/shared";
import type { ZCodeProtocolRequestId } from "@zcode/shared";
import type { ProtocolRuntimeResources } from "./runtime-resources.js";
import type { ParamsSchema } from "./server-types.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import type { ZCodeProtocolClientRequestOptions } from "./server-types.js";
import type { PendingClientRequest } from "./protocol-server-support.js";
import type { ZCodeProtocolOutboundMessage } from "./protocol-server-support.js";
import type { ZCodeProtocolPostResponseBatch } from "./protocol-server-support.js";
import type { requestMcpElicitation } from "./interaction-broker.js";
import type { McpElicitationResult } from "@zcode/contracts";
import type { ZCodeProtocolError } from "@zcode/shared";
import type { ZCodeProtocolResponse } from "@zcode/shared";
import type { McpElicitationRequest } from "@zcode/contracts";
import type { McpServerNotification } from "@zcode/contracts";
import type { ZCodeProtocolMessage } from "@zcode/shared";

/** 同一 owner 的唯一内部状态 / 协作形状；不从实现类反向取型。 */
export interface ZCodeProtocolAgentServerMethodsContext {
  readonly browserControlPort: BrowserControlPort;
  cancelPluginOperation(rawParams: unknown): { operationId: string; cancelled: boolean };
  cancelWorkspaceGenerateText(rawParams: unknown): { operationId: string; cancelled: boolean };
  cleanupClientRequest<T>(pending: PendingClientRequest<T>): void;
  clearPostResponseMessages(): void;
  clientDisconnectError: Error | undefined;
  collectMemoryDiagnostics(): Record<string, number>;
  readonly context: ZCodeProtocolAgentServerContext;
  disconnectClient(error: Error): void;
  dispatchRequest(request: ZCodeProtocolRequest): Promise<unknown>;
  disposeProjections(): void;
  fail(
    id: ZCodeProtocolRequestId,
    code: number,
    message: string,
    data?: unknown,
  ): ZCodeProtocolError;
  handleMcpNotification(notification: McpServerNotification): void;
  handleMessage(
    message: ZCodeProtocolMessage,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse | undefined>;
  handleRequest(request: ZCodeProtocolRequest): Promise<ZCodeProtocolError | ZCodeProtocolResponse>;
  readonly logger: import("@zcode/contracts").Logger | undefined;
  messageSink: ((message: ZCodeProtocolOutboundMessage) => void) | undefined;
  readonly networkCapture: ReturnType<typeof createNodeNetworkCapture>;
  nextClientRequestId: number;
  readonly officialMcpAuthRequestContext: Pick<ZCodeProtocolAgentServerContext, "requestClient">;
  ok(id: ZCodeProtocolRequestId, result: unknown): ZCodeProtocolResponse;
  readonly pendingClientRequests: Map<string, PendingClientRequest<unknown>>;
  readonly pluginOperationControllers: Map<string, AbortController>;
  readonly postResponseOutbox: Map<ZCodeProtocolRequestId, ZCodeProtocolPostResponseBatch>;
  pruneDetachedChildPublishers(nowMs?: number): number;
  pruneSessionEventStores(nowMs?: number): number;
  rebalanceResidentSessions(): void;
  rejectClientRequest(id: ZCodeProtocolRequestId, error: Error): void;
  requestClient<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T>;
  requestMcpElicitation(
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult>;
  requireV4Gateway(): NonNullable<ZCodeProtocolAgentServerMethodsContext["context"]["v4Gateway"]>;
  resolveClientRequest(id: ZCodeProtocolRequestId, result: unknown): void;
  readonly runtimeResources: ProtocolRuntimeResources;
  setNotificationSink(sink: (message: ZCodeProtocolOutboundMessage) => void): void;
  shutdown(): Promise<void>;
  shutdownPromise: Promise<void> | undefined;
  takePostResponseBatch(requestId: ZCodeProtocolRequestId): ZCodeProtocolPostResponseBatch | null;
  takePostResponseMessages(requestId: ZCodeProtocolRequestId): ZCodeProtocolOutboundMessage[];
  withPluginOperationSignal<T>(
    request: ZCodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T>;
  withWorkspaceGenerateTextSignal<T>(
    request: ZCodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T>;
  readonly workspaceGenerateTextControllers: Map<string, AbortController>;
}
