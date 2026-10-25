export const remoteWorkspacePreloadModule = {
  id: "remote-workspace-preload",
  requires: ["shared"],
  provides: ["remote-workspace-preload"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
