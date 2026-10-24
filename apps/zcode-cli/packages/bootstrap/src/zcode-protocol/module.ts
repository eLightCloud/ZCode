/**
 * cli-protocol-host 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliProtocolHostModule = {
  id: "cli-protocol-host",
  requires: [
    "cli-adapters",
    "cli-session-execution",
    "cli-telemetry",
    "mcp-apps-protocol",
    "mcp-ui",
    "provider",
    "shared",
    "zcode-cli",
    "cli-app-assembly",
    "cli-plugin-management",
  ],
  provides: ["cli-protocol-host"],
  publicEntrypoints: [
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts",
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/contract.ts",
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts",
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/index.ts",
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/replay.ts",
  ],
} as const;
