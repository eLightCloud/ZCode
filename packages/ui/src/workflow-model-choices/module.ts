/**
 * workflow-model-choices 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const workflowModelChoicesModule = {
  id: "workflow-model-choices",
  requires: ["ui", "shared", "provider"],
  provides: ["workflow-model-choices"],
  publicEntrypoints: [
    "packages/ui/src/workflow-model-choices/contract.ts",
    "packages/ui/src/components/workflow-timeline/useWorkflowSettingsModelChoices.ts",
  ],
} as const;
