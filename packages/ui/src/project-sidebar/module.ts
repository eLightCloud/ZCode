/** Declares the existing source-management projection dependency. */
export const projectSidebarModule = {
  id: "project-sidebar",
  requires: [
    "services",
    "shared",
    "ui",
    "conversation-workspace-target",
    "web-remote-control-ui",
    "remote-connection-flow",
    "source-server-management-view",
  ],
  provides: ["project-sidebar"],
  publicEntrypoints: [
    "packages/ui/src/project-sidebar/index.tsx",
    "packages/ui/src/project-sidebar/contract.ts",
    "packages/ui/src/project-sidebar/remote-project-connection.ts",
    "packages/ui/src/project-sidebar/useSavedWorkflowProjectOptions.ts",
    "packages/ui/src/project-sidebar/RemoteProjectMenu.tsx",
    "packages/ui/src/project-sidebar/WorkspaceDragOverlay.tsx",
    "packages/ui/src/project-sidebar/useRemoteProjectConnectionPresentation.ts",
    "packages/ui/src/project-sidebar/OfflineRemoteProjectRows.tsx",
    "packages/ui/src/project-sidebar/RemoteConversationDisconnected.tsx",
  ],
} as const;
