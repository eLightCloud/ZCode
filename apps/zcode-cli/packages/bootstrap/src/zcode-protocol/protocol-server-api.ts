import type { McpElicitationResult } from "@zcode/contracts";

import type { ZCodeProtocolError, ZCodeProtocolResponse } from "@zcode/shared";

import * as implementation5 from "./protocol-server-client-requests.js";
import * as implementation1 from "./protocol-server-lifecycle.js";
import * as implementation2 from "./protocol-server-messages.js";
import * as implementation0 from "./protocol-server-residency.js";
import type {
  ZCodeProtocolOutboundMessage,
  ZCodeProtocolPostResponseBatch,
} from "./protocol-server-support.js";
export interface ZCodeProtocolAgentServerApi {
  rebalanceResidentSessions(
    ...args: Parameters<typeof implementation0.rebalanceResidentSessions>
  ): void;
  pruneSessionEventStores(
    ...args: Parameters<typeof implementation0.pruneSessionEventStores>
  ): number;
  pruneDetachedChildPublishers(
    ...args: Parameters<typeof implementation0.pruneDetachedChildPublishers>
  ): number;
  collectMemoryDiagnostics(
    ...args: Parameters<typeof implementation0.collectMemoryDiagnostics>
  ): Record<string, number>;
  setNotificationSink(...args: Parameters<typeof implementation1.setNotificationSink>): void;
  disconnectClient(...args: Parameters<typeof implementation1.disconnectClient>): void;
  shutdown(...args: Parameters<typeof implementation1.shutdown>): Promise<void>;
  disposeProjections(...args: Parameters<typeof implementation1.disposeProjections>): void;
  takePostResponseMessages(
    ...args: Parameters<typeof implementation1.takePostResponseMessages>
  ): ZCodeProtocolOutboundMessage[];
  takePostResponseBatch(
    ...args: Parameters<typeof implementation1.takePostResponseBatch>
  ): ZCodeProtocolPostResponseBatch | null;
  clearPostResponseMessages(
    ...args: Parameters<typeof implementation1.clearPostResponseMessages>
  ): void;
  handleMessage(
    ...args: Parameters<typeof implementation2.handleMessage>
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse | undefined>;
  requestMcpElicitation(
    ...args: Parameters<typeof implementation5.requestMcpElicitation>
  ): Promise<McpElicitationResult>;
  handleMcpNotification(...args: Parameters<typeof implementation5.handleMcpNotification>): void;
}
