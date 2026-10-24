/**
 * native-runtime-maintenance 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const nativeRuntimeMaintenanceModule = {
  id: "native-runtime-maintenance",
  requires: ["services", "shared", "zcode-server-cli"],
  provides: ["native-runtime-maintenance"],
  publicEntrypoints: [
    "packages/zcode-server-cli/src/runtime/maintenance-contract/contract.ts",
    "packages/shared/src/runtimeMaintenance.ts",
    "packages/services/src/zcode-agent/localRuntimeMaintenance.ts",
    "packages/zcode-server-cli/src/runtime/kernelFileLock.ts",
    "packages/zcode-server-cli/src/runtime/updateHandoff.ts",
    "packages/zcode-server-cli/src/server-core/maintenance.ts",
    "packages/zcode-server-cli/src/supervisor/coreMaintenanceRequest.ts",
  ],
} as const;
