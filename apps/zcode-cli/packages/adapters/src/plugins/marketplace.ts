import { rm } from "node:fs/promises";

import { appendPluginSourceCleanupError } from "./helpers.js";

import { type AtomicDirectoryActivation } from "./atomic-directory.js";

import type { InstalledPluginRecord, MarketplaceInstallResult } from "./marketplace-contracts.js";

import { ensureMarketplaceManifestAvailable } from "./marketplace-registry.js";

import { throwIfPluginOperationAborted } from "./marketplace-operation-signal.js";

import { loadMarketplaceManifestSync } from "./marketplace-manifest.js";

import { resolveDependencyClosure } from "./marketplace-dependencies.js";

import {
  getPluginDataDir,
  loadInstalledPluginsSync,
  saveInstalledPlugins,
} from "./marketplace-storage.js";

import { parsePluginId } from "./marketplace-identifiers.js";

import { cacheMarketplacePlugin } from "./marketplace-plugin-cache.js";

export { buildMarketplaceGitEnv } from "./marketplace-git.js";

export type {
  DescribeMarketplacePluginResult,
  InstalledPluginRecord,
  InstalledPluginsState,
  KnownMarketplaceRecord,
  MarketplaceInstallResult,
  MarketplaceRefreshFailure,
  MarketplaceSource,
  PluginManifestDisplayMetadata,
  PluginMarketplaceEntry,
  PluginMarketplaceManifest,
  PluginValidationDiagnostic,
} from "./marketplace-contracts.js";

export {
  parseMarketplaceSourceInput,
  readPluginSourceIdentityPin,
  readPluginSourceSha,
} from "./marketplace-source.js";

export {
  getPluginDataDir,
  listInstalledPluginRecords,
  loadApplicationDefaultsSync,
  loadInstalledPluginsSync,
  loadKnownMarketplacesSync,
  resolveInstalledPluginRoot,
  saveInstalledPlugins,
} from "./marketplace-storage.js";

export {
  addMarketplace,
  ensureDefaultPluginMarketplaces,
  ensureMarketplaceManifestAvailable,
  removeMarketplace,
  updateMarketplace,
} from "./marketplace-registry.js";

export { applyClaudePluginIcons, parsePluginIconSources } from "./marketplace-icons.js";

export { enrichCachedClaudeMarketplaceIcons } from "./marketplace-icon-enrichment.js";

export {
  getMarketplaceManifestPath,
  loadMarketplaceManifestSync,
  normalizeAuthorValue,
  parseEntryStoreListing,
} from "./marketplace-manifest.js";

export {
  describeMarketplacePlugin,
  validateMarketplacePlugin,
} from "./marketplace-plugin-inspection.js";

export {
  validateLocalPluginPath,
  validateMarketplaceSource,
} from "./marketplace-source-validation.js";

// 组件枚举的类型定义在 plugin-components.ts；这里再导出，保持 adapter barrel 的对外契约稳定。
export type {
  PluginComponentGroup,
  PluginComponentItem,
  PluginComponentKind,
} from "./plugin-components.js";

export async function installMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  signal?: AbortSignal;
  storageRoot: string;
  scope?: "user" | "workspace";
  allowCrossMarketplaces?: ReadonlySet<string>;
}): Promise<MarketplaceInstallResult> {
  await ensureMarketplaceManifestAvailable({
    marketplace: input.marketplace,
    signal: input.signal,
    storageRoot: input.storageRoot,
  });
  throwIfPluginOperationAborted(input.signal);
  const rootManifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  const closure = resolveDependencyClosure({
    allowCrossMarketplaces:
      input.allowCrossMarketplaces ??
      new Set(rootManifest?.allowCrossMarketplaceDependenciesOn ?? []),
    marketplace: input.marketplace,
    name: input.name,
    storageRoot: input.storageRoot,
  });
  const state = loadInstalledPluginsSync(input.storageRoot);
  const installed: InstalledPluginRecord[] = [];
  const activations: AtomicDirectoryActivation[] = [];
  try {
    for (const pluginId of closure) {
      const { marketplace, name } = parsePluginId(pluginId);
      const manifest = loadMarketplaceManifestSync(input.storageRoot, marketplace);
      if (!manifest) throw new Error(`Marketplace not found: ${marketplace}`);
      const entry = manifest.plugins.find((plugin) => plugin.name === name);
      if (!entry) throw new Error(`Plugin not found: ${pluginId}`);
      const cached = await cacheMarketplacePlugin({
        entry,
        marketplace,
        signal: input.signal,
        scope: input.scope ?? "user",
        state,
        storageRoot: input.storageRoot,
      });
      installed.push(cached.record);
      if (cached.activation) activations.push(cached.activation);
    }
    throwIfPluginOperationAborted(input.signal);
    await saveInstalledPlugins(input.storageRoot, state);
  } catch (error) {
    let rollbackError: unknown;
    for (const activation of activations.reverse()) {
      try {
        await activation.rollback();
      } catch (currentRollbackError) {
        rollbackError ??= currentRollbackError;
      }
    }
    throw appendPluginSourceCleanupError(error, rollbackError);
  }
  for (const activation of activations) await activation.finalize();
  return { closure, installed };
}

export async function uninstallMarketplacePlugin(input: {
  pluginId: string;
  storageRoot: string;
  removeCache?: boolean;
  /** `zcode plugins uninstall --keep-data`：删安装缓存但保留 data/<plugin-id> 用户数据目录。 */
  keepData?: boolean;
}): Promise<InstalledPluginRecord | null> {
  const state = loadInstalledPluginsSync(input.storageRoot);
  const index = state.plugins.findIndex((record) => record.id === input.pluginId);
  if (index < 0) return null;
  const [removed] = state.plugins.splice(index, 1);
  await saveInstalledPlugins(input.storageRoot, state);
  if (removed && input.removeCache === true) {
    await rm(removed.installPath, { force: true, recursive: true });
    // 彻底卸载：data/<plugin-id> 是持久化的 per-plugin 目录（含 materialize 的 generated-commands）。
    // 按「卸载最后一份安装时一并删除」语义，保证重装是干净的。

    if (input.keepData !== true) {
      await rm(getPluginDataDir(input.storageRoot, removed.id), { force: true, recursive: true });
    }
  }
  return removed ?? null;
}
