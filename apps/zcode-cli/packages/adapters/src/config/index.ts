// 配置的稳定公开入口；存储实现不反向导入此装配 barrel。
// Re-export adapters and factory
export {
  addSuppressedBuiltinInFileConfig,
  enablePluginsByDefaultInFileConfig,
  getDefaultConfigPath,
  hasDefaultConfigFile,
  loadFileConfig,
  removePluginEnabledFromFileConfig,
  removePluginFromFileConfig,
  removeSuppressedBuiltinInFileConfig,
  resolvePath,
  updatePluginEnabledInFileConfig,
  updatePluginOptionsInFileConfig,
  updateUiLocaleInFileConfig,
  type PluginEnabledPatchResult,
  type PluginOptionsPatchResult,
  type PluginRemovePatchResult,
  type SuppressedBuiltinPatchResult,
  type UiLocalePatchResult,
} from "./file-config.adapter.js";
export { getToolConcurrencyConfig, parseEnvConfig } from "./env-config.adapter.js";
export { ZCodeConfigFileSchema, type ZCodeConfigFile } from "./schema.js";
export { createPrioritizedConfig, getScopePriority, mergeConfigs } from "./config-merger.js";
export {
  createConfig,
  resolveWorkspaceStorageDir,
  type ConfigFactoryOptions,
  type ConfigResult,
} from "./config-factory.js";
export { ConfigPortImpl, createConfigPort } from "./config-port.js";
