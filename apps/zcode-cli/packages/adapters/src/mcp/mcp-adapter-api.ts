import type {
  McpConnectionSnapshot,
  McpListResourceTemplatesResult,
  McpListResourcesResult,
  McpReadResourceResult,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from "@zcode/contracts";

import * as implementation0 from "./mcp-adapter-connection-api.js";
import * as implementation3 from "./mcp-adapter-connection-state.js";
import * as implementation6 from "./mcp-adapter-resources.js";
import * as implementation4 from "./mcp-adapter-tool-api.js";
export interface NodeMcpAdapterApi {
  connectConfiguredServers(
    ...args: Parameters<typeof implementation0.connectConfiguredServers>
  ): Promise<McpConnectionSnapshot>;
  connectServer(
    ...args: Parameters<typeof implementation0.connectServer>
  ): Promise<McpServerStatus>;
  disconnectServer(
    ...args: Parameters<typeof implementation0.disconnectServer>
  ): Promise<McpServerStatus | undefined>;
  status(
    ...args: Parameters<typeof implementation0.status>
  ): Promise<Record<string, McpServerStatus>>;
  pingServer(...args: Parameters<typeof implementation0.pingServer>): Promise<boolean>;
  toolListRevision(...args: Parameters<typeof implementation0.toolListRevision>): number;
  close(...args: Parameters<typeof implementation0.close>): Promise<void>;
  onAppConnectionInvalidated(
    ...args: Parameters<typeof implementation3.onAppConnectionInvalidated>
  ): () => void;
  appConnectionSnapshot(
    ...args: Parameters<typeof implementation3.appConnectionSnapshot>
  ): { identity: string; generation: number } | null;
  listTools(...args: Parameters<typeof implementation4.listTools>): Promise<McpToolDescriptor[]>;
  callTool(...args: Parameters<typeof implementation4.callTool>): Promise<McpToolCallResult>;
  readResource(
    ...args: Parameters<typeof implementation4.readResource>
  ): Promise<McpReadResourceResult>;
  listResources(
    ...args: Parameters<typeof implementation6.listResources>
  ): Promise<McpListResourcesResult>;
  listResourceTemplates(
    ...args: Parameters<typeof implementation6.listResourceTemplates>
  ): Promise<McpListResourceTemplatesResult>;
  subscribeResource(...args: Parameters<typeof implementation6.subscribeResource>): Promise<void>;
  unsubscribeResource(
    ...args: Parameters<typeof implementation6.unsubscribeResource>
  ): Promise<void>;
  unsubscribeResourcesBySubscriber(
    ...args: Parameters<typeof implementation6.unsubscribeResourcesBySubscriber>
  ): Promise<number>;
  resourceSubscriptionCounts(
    ...args: Parameters<typeof implementation6.resourceSubscriptionCounts>
  ): Record<string, Record<string, number>>;
}
