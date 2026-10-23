import { AgentRuntimeConfig } from "@zcode/core";

import { Logger, McpServerConfig } from "@zcode/contracts";

import type { ZCodeAppOptions } from "./types.js";

import { runtimeConfigLogContext } from "./runtime-config.js";

import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";

import { StartupTimer } from "../startup-logging.js";

export function configureAppBrowserResources(
  options: ZCodeAppOptions,
  pluginRuntimeFeatures: {
    nodeRepl?: boolean;
    browserUse?: boolean;
    computerUse?: boolean;
    browserDocumentationRoot?: string;
  },
  runtimeConfig: AgentRuntimeConfig,
  browserResources: {
    nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
    ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  },
  logger: Logger,
  configuredMcpServers: Record<string, McpServerConfig>,
  startupTimer: StartupTimer,
  workingDirectory: string,
) {
  const browserControlPort = options.browserControlPort;
  if (
    browserControlPort &&
    pluginRuntimeFeatures.browserUse === true &&
    runtimeConfig.mcp?.servers?.node_repl?.type === "stdio"
  ) {
    browserResources.nodeReplBrowserBroker =
      options.nodeReplBrowserBroker ??
      (browserResources.ownedNodeReplBrowserBroker = createNodeReplBrowserBroker({
        browserControlPort,
        logger,
        platform: options.platform,
      }));
    configuredMcpServers = injectNodeReplBrowserBroker(
      configuredMcpServers,
      browserResources.nodeReplBrowserBroker,
    );
    runtimeConfig.mcp = {
      ...runtimeConfig.mcp,
      servers: injectNodeReplBrowserBroker(
        runtimeConfig.mcp.servers ?? {},
        browserResources.nodeReplBrowserBroker,
      ),
    };
  }
  startupTimer.mark("ZCode runtime configuration resolved", {
    context: runtimeConfigLogContext(runtimeConfig, workingDirectory),
    event: "bootstrap.app.startup.runtime_config.completed",
    stage: "resolve_runtime_config",
  });
  return { browserControlPort, configuredMcpServers };
}
