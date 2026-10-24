/** Declares the existing source-management projection dependency. */
export const remoteConnectionFlowModule = {
  id: "remote-connection-flow",
  requires: ["shared", "ui", "source-server-management-view"],
  provides: ["remote-connection-flow"],
  publicEntrypoints: [
    "packages/ui/src/remote-connection-flow/index.ts",
    "packages/ui/src/remote-connection-flow/contract.ts",
    "packages/ui/src/remote-connection-flow/ui/RemoteConnectionProgress.tsx",
  ],
} as const;
