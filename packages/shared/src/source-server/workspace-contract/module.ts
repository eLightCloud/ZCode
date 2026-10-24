/** Existing component metadata; behavior remains at the original public entries. */
export const moduleDefinition = {
  id: "source-server-workspace-contract",
  requires: ["services", "shared"],
  provides: ["source-server-workspace-contract"],
  publicEntrypoints: [
    "packages/shared/src/source-server/workspace-contract/index.ts",
    "packages/shared/src/source-server/workspace-contract/contract.ts",
    "packages/shared/src/source-server/errorCodes.ts",
    "packages/services/src/source-server-workspace/sourceServerWorkspace.ts",
  ],
} as const;
