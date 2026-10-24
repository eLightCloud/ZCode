import { McpResourceSubscribeUnsupportedError } from "@zcode/contracts";

import { listMcpServerStatuses } from "../mcp-config.js";

import type { CreateSessionFacadeDeps, SessionFacade } from "./session-facade-contract.js";

export function createSessionMcpReadFacade(
  deps: CreateSessionFacadeDeps,
): Pick<
  SessionFacade,
  | "listMcpServers"
  | "connectMcpServer"
  | "readMcpResource"
  | "readMcpResourceForUi"
  | "listMcpResourcesForUi"
  | "listMcpResourceTemplatesForUi"
  | "subscribeMcpResourceForUi"
  | "unsubscribeMcpResourceForUi"
  | "unsubscribeMcpResourcesForUi"
  | "onMcpAppConnectionInvalidated"
  | "getMcpAppConnectionSnapshot"
  | "waitForMcpAppConnection"
> {
  return {
    listMcpServers: async () =>
      listMcpServerStatuses(
        deps.mcpPort,
        deps.configuredMcpServers,
        deps.untrustedProjectMcpServers,
      ),
    connectMcpServer: async (name) => {
      const config = deps.configuredMcpServers[name];
      if (!config) {
        throw new Error(`MCP server is not configured: ${name}`);
      }
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      return deps.mcpPort.connectServer(name, config, {
        trace: deps.traceContext,
        workingDirectory: deps.workingDirectory,
      });
    },
    readMcpResource: async (serverName, uri, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      if (!deps.mcpPort.readResource) {
        throw new Error("MCP resources are not supported by this runtime");
      }
      return deps.mcpPort.readResource(
        { serverName, uri, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    readMcpResourceForUi: async (serverName, uri, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      if (!deps.mcpPort.readResource) {
        throw new Error("MCP resources are not supported by this runtime");
      }
      return deps.mcpPort.readResource(
        { serverName, uri, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    listMcpResourcesForUi: async (serverName, cursor, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.listResources) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      return deps.mcpPort.listResources(
        { serverName, ...(cursor ? { cursor } : {}), trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    listMcpResourceTemplatesForUi: async (serverName, cursor, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.listResourceTemplates) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      return deps.mcpPort.listResourceTemplates(
        { serverName, ...(cursor ? { cursor } : {}), trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    subscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.subscribeResource) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      await deps.mcpPort.subscribeResource(
        { serverName, uri, subscriberKey, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    unsubscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!deps.mcpPort?.unsubscribeResource) return;
      await deps.mcpPort.unsubscribeResource(
        { serverName, uri, subscriberKey, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    unsubscribeMcpResourcesForUi: async (subscriberKeyPrefix) => {
      if (!deps.mcpPort?.unsubscribeResourcesBySubscriber) return 0;
      return deps.mcpPort.unsubscribeResourcesBySubscriber(subscriberKeyPrefix);
    },
    onMcpAppConnectionInvalidated: (name, listener) =>
      deps.mcpPort?.onAppConnectionInvalidated?.(name, listener) ?? (() => {}),
    waitForMcpAppConnection: async (name) =>
      deps.mcpPort?.waitForAppConnection
        ? deps.mcpPort.waitForAppConnection(name)
        : (deps.mcpPort?.appConnectionSnapshot?.(name) ?? null),
    getMcpAppConnectionSnapshot: (name) => deps.mcpPort?.appConnectionSnapshot?.(name) ?? null,
  } satisfies Partial<SessionFacade>;
}
