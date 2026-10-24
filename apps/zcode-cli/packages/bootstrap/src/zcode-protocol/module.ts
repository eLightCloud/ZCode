/**
 * cli-protocol-host 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliProtocolHostModule = {
  id: "cli-protocol-host",
  requires: [
    "cli-app-assembly",
    "cli-adapters",
    "cli-session-execution",
    "cli-telemetry",
    "mcp-apps-protocol",
    "mcp-ui",
    "provider",
    "shared",
    "zcode-cli",
  ],
  provides: ["cli-protocol-host"],
  publicEntrypoints: [
    "server.ts",
    "contract.ts",
    "transport.ts",
    "../zcode-protocol-v4/index.ts",
    "../zcode-protocol-v4/replay.ts",
  ],
} as const;
