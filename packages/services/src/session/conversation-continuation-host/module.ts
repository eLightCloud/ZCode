/**
 * conversation-continuation-host 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const conversationContinuationHostModule = {
  id: "conversation-continuation-host",
  requires: ["services", "session", "shared"],
  provides: ["conversation-continuation-host"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
