/**
 * cli-execution-contracts 模块清单（architecture-governance managed 模块）。
 * 层：domain。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliExecutionContractsModule = {
  id: "cli-execution-contracts",
  requires: ["cli-model-contracts", "mcp-apps-protocol", "shared", "zcode-cli"],
  provides: ["cli-execution-contracts"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "browser-control.port.ts",
    "mcp.port.ts",
    "shared.ts",
    "../events/index.ts",
    "../workflow/index.ts",
  ],
} as const;
