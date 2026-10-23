import { writeBundledOfficialMarketplacePartitionSync } from "@zcode/adapters";

import {
  isTransientOfficialPluginCacheFsError,
  type OfficialPluginCacheRetryBudget,
} from "./official-plugin-cache-fs.js";

import { writeOfficialPluginRuntimeManifest } from "./official-plugin-runtime.js";

import { OFFICIAL_PLUGIN_MARKETPLACE, readSeedFileBytes } from "./bundled-plugin-source.js";

import type {
  OfficialPluginSeedPluginSource,
  OfficialPluginSeedSource,
} from "./bundled-plugin-source.js";

import { officialPluginCacheRoot } from "./bundled-plugin-cache.js";

export function tryWriteOfficialPluginRuntimeManifest(input: {
  pluginName: string;
  retryBudget: OfficialPluginCacheRetryBudget;
  rootPath: string;
}): boolean {
  try {
    writeOfficialPluginRuntimeManifest(input);
    return true;
  } catch (error) {
    if (isTransientOfficialPluginCacheFsError(error)) throw error;
    return false;
  }
}

export function writeOfficialMarketplace(
  storageRoot: string,
  source: OfficialPluginSeedSource,
): void {
  writeBundledOfficialMarketplacePartitionSync({
    manifest: {
      name: OFFICIAL_PLUGIN_MARKETPLACE,
      plugins: source.plugins.map((plugin) => {
        // 商店信息（listing）与描述随目录条目下发：键名与 CDN 目录 schema 一致，
        // 由 adapter 的同一套 parseEntryStoreListing 解析，UI 才能给内置插件渲染
        // 显示名/分类/作者/示例提示词。描述取自插件包内 plugin.json（单一事实源）。
        const description = readSeedPluginDescription(source, plugin);
        return {
          cachePath: officialPluginCacheRoot(storageRoot, plugin.definition),
          ...(description ? { description } : {}),
          name: plugin.definition.name,
          source: source.kind,
          version: plugin.definition.version,
          ...(plugin.definition.listing ?? {}),
        };
      }),
      version: 1,
    },
    storageRoot,
  });
}

/** 从 seed 文件集中读插件 plugin.json 的 description；读取/解析失败按 undefined 降级。 */
export function readSeedPluginDescription(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
): string | undefined {
  const manifestFile = plugin.files.find((file) => file.path === ".zcode-plugin/plugin.json");
  if (!manifestFile) return undefined;
  try {
    const parsed = JSON.parse(readSeedFileBytes(source, plugin, manifestFile).toString("utf8")) as {
      description?: unknown;
    };
    return typeof parsed.description === "string" && parsed.description.trim().length > 0
      ? parsed.description
      : undefined;
  } catch {
    return undefined;
  }
}
