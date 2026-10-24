/**
 * cli-workflow 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliWorkflowModule = {
  id: "cli-workflow",
  requires: ["zcode-cli"],
  provides: ["cli-workflow"],
  publicEntrypoints: [
    "apps/zcode-cli/packages/core/src/workflow/contract.ts",
    "apps/zcode-cli/packages/core/src/workflow/definition.ts",
    "apps/zcode-cli/packages/core/src/workflow/expert.ts",
    "apps/zcode-cli/packages/core/src/workflow/lifecycle.ts",
    "apps/zcode-cli/packages/core/src/workflow/scheduler.ts",
  ],
} as const;
