/** Conversation history, continuation and exact-version file reads share the existing UI owner. */
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
    "packages/ui/src/hooks/useConversationFileDownload.ts",
  ],
} as const;
