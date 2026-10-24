/**
 * cli-adapters 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliAdaptersModule = {
  id: "cli-adapters",
  requires: ["mcp-apps-protocol", "provider", "shared", "sqlite-migrations", "zcode-cli"],
  provides: ["cli-adapters"],
  publicEntrypoints: [
    "index.ts",
    "storage/index.ts",
    "fs/index.ts",
    "context/index.ts",
    "exec/index.ts",
    "http/index.ts",
    "image/index.ts",
    "pdf/index.ts",
    "provider/index.ts",
    "model/index.ts",
    "logging/index.ts",
    "config/index.ts",
    "skills/index.ts",
    "commands/index.ts",
    "plugins/index.ts",
    "auth/index.ts",
    "browser/index.ts",
    "mcp/index.ts",
    "mailbox/index.ts",
    "workflow/index.ts",
    "tools/index.ts",
    "conversation-sync/index.ts",
    "contract.ts",
  ],
} as const;
