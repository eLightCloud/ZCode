/** Existing component metadata; behavior remains at the original public entries. */
export const moduleDefinition = {
  id: "source-server-transport",
  requires: ["server", "shared"],
  provides: ["source-server-transport"],
  publicEntrypoints: [
    "packages/server/src/source-server/transport-contract/index.ts",
    "packages/server/src/source-server/transport-contract/contract.ts",
    "packages/server/src/source-server/sourceServerTransportRuntime.ts",
    "packages/server/src/source-server/transportAdapter.ts",
  ],
} as const;
