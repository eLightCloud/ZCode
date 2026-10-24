/** Existing component metadata; behavior remains at the original public entries. */
export const moduleDefinition = {
  id: "workspace-ignore-storage",
  requires: ["services"],
  provides: ["workspace-ignore-storage"],
  publicEntrypoints: [
    "packages/services/src/file/ignore-contract/index.ts",
    "packages/services/src/file/ignore-contract/contract.ts",
    "packages/services/src/file/workspaceFileIgnore.ts",
  ],
} as const;
