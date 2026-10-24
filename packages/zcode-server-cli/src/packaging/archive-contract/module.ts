/** Existing component metadata; behavior remains at the original public entries. */
export const moduleDefinition = {
  id: "native-release-archives",
  requires: ["zcode-server-cli"],
  provides: ["native-release-archives"],
  publicEntrypoints: [
    "packages/zcode-server-cli/src/packaging/archive-contract/index.ts",
    "packages/zcode-server-cli/src/packaging/archive-contract/contract.ts",
    "packages/zcode-server-cli/src/packaging/stageArchives.ts",
  ],
} as const;
