/**
 * conversation-native-protocol 模块清单（architecture-governance managed 模块）。
 * 层：domain。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const conversationNativeProtocolModule = {
  id: "conversation-native-protocol",
  requires: ["shared"],
  provides: ["conversation-native-protocol"],
  publicEntrypoints: [
    "packages/shared/src/conversation-native-protocol/contract.ts",
    "packages/shared/src/conversation-sync.ts",
    "packages/shared/src/conversation-runtime.ts",
    "packages/shared/src/conversation-files.ts",
    "packages/shared/src/conversation-continuation.ts",
    "packages/shared/src/zcode-task-search-text.ts",
  ],
} as const;
