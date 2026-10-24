/**
 * cli-app-assembly 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliAppAssemblyModule = {
  id: "cli-app-assembly",
  requires: [
    "cli-adapters",
    "cli-network",
    "cli-subagent-config",
    "cli-telemetry",
    "mcp-apps-protocol",
    "provider",
    "provider-node",
    "shared",
    "zcode-cli",
    "cli-plugin-management",
  ],
  provides: ["cli-app-assembly"],
  publicEntrypoints: [
    "apps/zcode-cli/packages/bootstrap/src/app/app-option-types.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/artifact-store.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/browser-broker-port.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/bundled-skills.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/contract.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/create-app.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-observation.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-service.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/model-execution-context.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/paths.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/provider-registry-selection.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/session-residency-finalization.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/session-store.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/startup-marks.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/subagent-session-contract.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/subagent-session-query.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/types.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/visualize-skill-gate.ts",
  ],
} as const;
