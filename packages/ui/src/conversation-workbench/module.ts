/**
 * conversation-workbench 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const conversationWorkbenchModule = {
  id: "conversation-workbench",
  requires: ["ui", "shared"],
  provides: ["conversation-workbench"],
  publicEntrypoints: [
    "packages/ui/src/conversation-workbench/contract.ts",
    "packages/ui/src/components/ConversationContinuation.tsx",
    "packages/ui/src/components/ConversationHistory.tsx",
    "packages/ui/src/hooks/useConversationContinuation.ts",
    "packages/ui/src/hooks/useConversationHistory.ts",
  ],
} as const;
