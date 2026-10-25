import type { RemoteWorkspacePreloadPort } from "./contract.js";
export const remoteWorkspaceScopeExample: Parameters<
  RemoteWorkspacePreloadPort["bindRemoteWorkspaceSessionContext"]
>[0] = { remoteSessionId: "logical-session", workspacePath: "/owned/workspace" };
