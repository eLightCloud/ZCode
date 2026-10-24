/**
 * cli-runtime 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliRuntimeModule = {
  id: "cli-runtime",
  requires: ["gen-ui-service", "mcp-apps-protocol", "shared", "zcode-cli"],
  provides: ["cli-runtime"],
  publicEntrypoints: ["../runtime.ts", "contract.ts"],
} as const;
