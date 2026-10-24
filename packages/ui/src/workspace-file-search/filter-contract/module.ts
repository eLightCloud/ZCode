/** Existing component metadata; behavior remains at the original public entries. */
export const moduleDefinition = {
  id: "workspace-file-filter",
  requires: ["ui", "shared"],
  provides: ["workspace-file-filter"],
  publicEntrypoints: [
    "packages/ui/src/workspace-file-search/filter-contract/index.ts",
    "packages/ui/src/workspace-file-search/filter-contract/contract.ts",
    "packages/ui/src/workspace-file-search/workspaceFileSearchFilterBackend.ts",
  ],
} as const;
