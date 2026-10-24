/** Existing component metadata; behavior remains at the original public entries. */
export const moduleDefinition = {
  id: "desktop-operation-indicator",
  requires: ["shared"],
  provides: ["desktop-operation-indicator"],
  publicEntrypoints: [
    "packages/desktop/src/main/operation-indicator-contract/index.ts",
    "packages/desktop/src/main/operation-indicator-contract/contract.ts",
    "packages/desktop/src/main/windowsCuaOperationIndicatorContent.ts",
  ],
} as const;
