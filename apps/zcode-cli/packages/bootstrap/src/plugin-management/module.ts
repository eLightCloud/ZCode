/**
 * cli-plugin-management 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliPluginManagementModule = {
  id: "cli-plugin-management",
  requires: ["cli-adapters", "shared", "zcode-cli"],
  provides: ["cli-plugin-management"],
  publicEntrypoints: [
    "apps/zcode-cli/packages/bootstrap/src/plugin-management/contract.ts",
    "apps/zcode-cli/packages/bootstrap/src/plugins.ts",
    "apps/zcode-cli/packages/bootstrap/src/plugins-contracts.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-runtime.ts",
  ],
} as const;
