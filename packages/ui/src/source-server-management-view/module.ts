/** Existing component metadata; behavior remains at the original public entries. */
export const moduleDefinition = {
  id: "source-server-management-view",
  requires: ["ui", "shared", "services"],
  provides: ["source-server-management-view"],
  publicEntrypoints: [
    "packages/ui/src/source-server-management-view/index.ts",
    "packages/ui/src/source-server-management-view/contract.ts",
    "packages/ui/src/WorkspaceSidebar/RemoteProjectDetailsPopover.tsx",
    "packages/ui/src/hooks/useSourceServerManagementSnapshot.ts",
    "packages/ui/src/settings/SourceServerMigrationReportPanel.tsx",
    "packages/ui/src/store/sourceServerDisplayNameRegistry.ts",
  ],
} as const;
