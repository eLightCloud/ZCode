/**
 * cli-hooks 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliHooksModule = {
  id: "cli-hooks",
  requires: ["shared", "zcode-cli"],
  provides: ["cli-hooks"],
  publicEntrypoints: [
    "apps/zcode-cli/packages/core/src/hooks/contract.ts",
    "apps/zcode-cli/packages/core/src/hooks/index.ts",
    "apps/zcode-cli/packages/core/src/hooks/types.ts",
    "apps/zcode-cli/packages/core/src/hooks/workspace-hook-runtime-admission.ts",
  ],
} as const;
