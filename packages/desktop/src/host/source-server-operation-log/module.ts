/** Existing component metadata; behavior remains at the original public entries. */
export const moduleDefinition = {
  id: "source-server-operation-log",
  requires: ["desktop", "shared", "rpc", "server"],
  provides: ["source-server-operation-log"],
  publicEntrypoints: [
    "packages/desktop/src/host/source-server-operation-log/index.ts",
    "packages/desktop/src/host/source-server-operation-log/contract.ts",
    "packages/desktop/src/host/sourceServerOperationLogs.ts",
  ],
} as const;
