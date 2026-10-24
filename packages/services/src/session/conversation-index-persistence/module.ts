/**
 * conversation-index-persistence 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const conversationIndexPersistenceModule = {
  id: "conversation-index-persistence",
  requires: ["services", "session", "shared"],
  provides: ["conversation-index-persistence"],
  publicEntrypoints: [
    "packages/services/src/session/conversation-index-persistence/contract.ts",
    "packages/services/src/session/conversationSyncIndex.ts",
    "packages/services/src/session/tasksDatabase/conversation-barrier-v5.ts",
    "packages/services/src/session/tasksDatabase/conversation-classification-v4.ts",
  ],
} as const;
