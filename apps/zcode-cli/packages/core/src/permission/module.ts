/**
 * cli-permission 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliPermissionModule = {
  id: "cli-permission",
  requires: ["cli-tool-runtime", "shared", "zcode-cli"],
  provides: ["cli-permission"],
  publicEntrypoints: [
    "apps/zcode-cli/packages/core/src/permission/broker.ts",
    "apps/zcode-cli/packages/core/src/permission/contract.ts",
    "apps/zcode-cli/packages/core/src/permission/index.ts",
    "apps/zcode-cli/packages/core/src/permission/rule-matching.ts",
    "apps/zcode-cli/packages/core/src/permission/service.ts",
    null,
  ],
} as const;
