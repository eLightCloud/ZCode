/**
 * cli-model-contracts 模块清单（architecture-governance managed 模块）。
 * 层：domain。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliModelContractsModule = {
  id: "cli-model-contracts",
  requires: ["cli-execution-contracts", "shared", "zcode-cli"],
  provides: ["cli-model-contracts"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
