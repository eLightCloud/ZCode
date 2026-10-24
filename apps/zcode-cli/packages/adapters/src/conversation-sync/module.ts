/** Native sync's own integration fixtures consume the same storage and sync public facades. */
export const conversationSyncModule = {
  id: "conversation-sync",
  requires: ["cli-network", "shared", "zcode-cli", "cli-adapters"],
  provides: ["conversation-sync"],
  publicEntrypoints: [
    "apps/zcode-cli/packages/adapters/src/conversation-sync/index.ts",
    "apps/zcode-cli/packages/adapters/src/conversation-sync/contract.ts",
  ],
} as const;
