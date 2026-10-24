/**
 * cli-process-entry 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliProcessEntryModule = {
  id: "cli-process-entry",
  requires: [
    "cli-adapters",
    "cli-arguments",
    "provider-node",
    "shared",
    "sqlite-migrations",
    "zcode-cli",
  ],
  provides: ["cli-process-entry"],
  publicEntrypoints: [
    "apps/zcode-cli/packages/cli/src/run.ts",
    "apps/zcode-cli/packages/cli/src/contract.ts",
  ],
} as const;
