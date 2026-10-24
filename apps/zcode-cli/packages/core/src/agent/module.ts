/**
 * cli-agent-history 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliAgentHistoryModule = {
  id: "cli-agent-history",
  requires: ["cli-tool-runtime", "zcode-cli"],
  provides: ["cli-agent-history"],
  publicEntrypoints: [
    "apps/zcode-cli/packages/core/src/agent/agent-listing-metadata.ts",
    "apps/zcode-cli/packages/core/src/agent/attachment-data-url.ts",
    "apps/zcode-cli/packages/core/src/agent/compact-session.ts",
    "apps/zcode-cli/packages/core/src/agent/contract.ts",
    "apps/zcode-cli/packages/core/src/agent/index.ts",
    "apps/zcode-cli/packages/core/src/agent/loaded-skills.ts",
    "apps/zcode-cli/packages/core/src/agent/message-history-contract.ts",
    "apps/zcode-cli/packages/core/src/agent/message-history-usage.ts",
    "apps/zcode-cli/packages/core/src/agent/message-history.ts",
    "apps/zcode-cli/packages/core/src/agent/plan-file-continuity.ts",
    "apps/zcode-cli/packages/core/src/agent/read-file-state-hydrator.ts",
    "apps/zcode-cli/packages/core/src/agent/runtime-input-presentation.ts",
    "apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts",
    "apps/zcode-cli/packages/core/src/agent/turn-machine.ts",
    "apps/zcode-cli/packages/core/src/agent/turn-state.ts",
    "apps/zcode-cli/packages/core/src/agent/video-input.ts",
  ],
} as const;
