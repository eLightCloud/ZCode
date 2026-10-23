import { BUNDLED_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";

import { mkdirSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";

import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

import { type DefaultPluginMarketplace } from "@zcode/shared";

import { parseApplicationDefaults } from "./application-managed-defaults.js";

import { isRecord, sanitizePluginId } from "./helpers.js";

import { recoverAtomicTargetSync } from "./atomic-directory.js";

import type {
  InstalledPluginRecord,
  InstalledPluginsState,
  KnownMarketplaceActivation,
  KnownMarketplaceRecord,
  MarketplaceRefreshFailure,
} from "./marketplace-contracts.js";

import { readJsonFileSync, writeJsonFile } from "./marketplace-json-files.js";

import {
  DEFAULT_VERSION,
  INSTALLED_PLUGINS_FILE,
  KNOWN_MARKETPLACES_FILE,
} from "./marketplace-constants.js";

import { parsePluginId } from "./marketplace-identifiers.js";

export function loadKnownMarketplacesSync(storageRoot: string): KnownMarketplaceRecord[] {
  const parsed = readJsonFileSync(join(storageRoot, KNOWN_MARKETPLACES_FILE));
  if (!isRecord(parsed)) return [];
  const value = parsed.marketplaces;
  const records = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  return records
    .filter(isKnownMarketplaceRecord)
    .filter(
      (item) =>
        BUNDLED_PLUGIN_MARKETPLACE_ID === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE ||
        item.id !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    );
}

export function loadApplicationDefaultsSync(
  storageRoot: string,
): DefaultPluginMarketplace[] | null {
  const parsed = readJsonFileSync(join(storageRoot, KNOWN_MARKETPLACES_FILE));
  const configured = isRecord(parsed) ? parseApplicationDefaults(parsed.applicationDefaults) : null;
  if (BUNDLED_PLUGIN_MARKETPLACE_ID === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) return configured;
  // 应用发行身份与本地 bundled 分片一致，退出官方 CDN 的默认补回路径。
  return [
    {
      id: BUNDLED_PLUGIN_MARKETPLACE_ID,
      source: join(storageRoot, "marketplaces", BUNDLED_PLUGIN_MARKETPLACE_ID, "marketplace.json"),
      name: BUNDLED_PLUGIN_MARKETPLACE_ID,
      description: "Application bundled plugins",
      pluginCount: 0,
    },
    ...(configured ?? []).filter(
      (item) =>
        item.id !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE && item.id !== BUNDLED_PLUGIN_MARKETPLACE_ID,
    ),
  ];
}

export function loadInstalledPluginsSync(storageRoot: string): InstalledPluginsState {
  const parsed = readJsonFileSync(join(storageRoot, INSTALLED_PLUGINS_FILE));
  return normalizeInstalledPluginsState(parsed);
}

export async function saveInstalledPlugins(
  storageRoot: string,
  state: InstalledPluginsState,
): Promise<void> {
  await writeJsonFile(join(storageRoot, INSTALLED_PLUGINS_FILE), state);
}

export function listInstalledPluginRecords(storageRoot: string): InstalledPluginRecord[] {
  return loadInstalledPluginsSync(storageRoot).plugins;
}

export function resolveInstalledPluginRoot(
  storageRoot: string,
  record: InstalledPluginRecord,
): string {
  const root =
    record.installPath ||
    getPluginCacheDir(storageRoot, record.marketplace, record.name, record.version);
  return recoverAtomicTargetSync(root);
}

export async function upsertKnownMarketplace(
  storageRoot: string,
  record: KnownMarketplaceRecord,
): Promise<KnownMarketplaceActivation> {
  const known = loadKnownMarketplacesSync(storageRoot);
  const index = known.findIndex((item) => item.id === record.id);
  const previous = index >= 0 ? known[index] : undefined;
  if (index >= 0) {
    const {
      cacheTransactionId: _previousCacheTransactionId,
      lastRefreshFailure: _lastRefreshFailure,
      ...successfulPrevious
    } = previous ?? record;
    known[index] = {
      ...successfulPrevious,
      ...record,
      addedAt: previous?.addedAt ?? record.addedAt,
    };
  } else {
    known.push(record);
  }
  await writeKnownMarketplaces(storageRoot, known);
  let settled = false;
  return {
    finalize: () => {
      settled = true;
    },
    rollback: async () => {
      if (settled) return;
      const current = loadKnownMarketplacesSync(storageRoot);
      const currentIndex = current.findIndex((item) => item.id === record.id);
      const currentRecord = currentIndex >= 0 ? current[currentIndex] : undefined;
      if (
        !currentRecord ||
        currentRecord.lastUpdated !== record.lastUpdated ||
        currentRecord.cacheTransactionId !== record.cacheTransactionId
      ) {
        throw new Error(
          `Cannot roll back marketplace authority after concurrent update: ${record.id}`,
        );
      }
      if (previous) {
        current[currentIndex] = previous;
      } else {
        current.splice(currentIndex, 1);
      }
      await writeKnownMarketplaces(storageRoot, current);
      settled = true;
    },
  };
}

export async function persistMarketplaceRefreshFailure(
  storageRoot: string,
  marketplace: string,
  failure: MarketplaceRefreshFailure,
): Promise<void> {
  const known = loadKnownMarketplacesSync(storageRoot);
  const index = known.findIndex((record) => record.id === marketplace);
  if (index < 0 || !known[index]) return;
  known[index] = { ...known[index], lastRefreshFailure: failure };
  await writeKnownMarketplaces(storageRoot, known);
}

export async function writeKnownMarketplaces(
  storageRoot: string,
  marketplaces: KnownMarketplaceRecord[],
): Promise<void> {
  await writeJsonFile(join(storageRoot, KNOWN_MARKETPLACES_FILE), {
    version: 1,
    marketplaces,
    ...applicationDefaultsField(storageRoot),
  });
}

export function applicationDefaultsField(storageRoot: string): Record<string, unknown> {
  const parsed = readJsonFileSync(join(storageRoot, KNOWN_MARKETPLACES_FILE));
  if (!isRecord(parsed) || !("applicationDefaults" in parsed)) return {};
  return { applicationDefaults: parsed.applicationDefaults };
}

export function writeKnownMarketplacesSync(
  storageRoot: string,
  marketplaces: KnownMarketplaceRecord[],
): void {
  const path = join(storageRoot, KNOWN_MARKETPLACES_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: 1,
        marketplaces,
        ...applicationDefaultsField(storageRoot),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function normalizeInstalledPluginsState(value: unknown): InstalledPluginsState {
  if (!isRecord(value)) return { version: 1, plugins: [] };
  const rawPlugins = value.plugins;
  if (isRecord(rawPlugins)) {
    return {
      version: 1,
      plugins: Object.entries(rawPlugins).flatMap(([pluginId, entry]) =>
        normalizeInstalledPluginRecordFromMap(pluginId, entry),
      ),
    };
  }
  const plugins = Array.isArray(rawPlugins) ? rawPlugins : [];
  return {
    version: 1,
    plugins: plugins.filter(isInstalledPluginRecord),
  };
}

export function normalizeInstalledPluginRecordFromMap(
  pluginId: string,
  entry: unknown,
): InstalledPluginRecord[] {
  const entries = Array.isArray(entry) ? entry : [entry];
  return entries.flatMap((item): InstalledPluginRecord[] => {
    if (!isRecord(item)) return [];
    const installPath = typeof item.installPath === "string" ? item.installPath : "";
    if (!installPath) return [];
    let parsed: { marketplace: string; name: string };
    try {
      parsed = parsePluginId(pluginId);
    } catch {
      return [];
    }
    const scope = item.scope === "project" || item.scope === "local" ? "workspace" : "user";
    return [
      {
        id: pluginId,
        name: parsed.name,
        marketplace: parsed.marketplace,
        version: typeof item.version === "string" ? item.version : DEFAULT_VERSION,
        installPath,
        installedAt:
          typeof item.installedAt === "string" ? item.installedAt : new Date(0).toISOString(),
        ...(typeof item.lastUpdated === "string" ? { updatedAt: item.lastUpdated } : {}),
        scope,
      },
    ];
  });
}

export function getPluginCacheDir(
  storageRoot: string,
  marketplace: string,
  name: string,
  version: string,
): string {
  return join(
    storageRoot,
    "cache",
    sanitizePluginId(marketplace),
    sanitizePluginId(name),
    sanitizePluginId(version),
  );
}

export function getPluginDataDir(storageRoot: string, pluginId: string): string {
  // 与 NodePluginAdapter.discoverPluginsSync 的 dataPath 解析保持一致：<storageRoot>/data/<sanitized-id>。
  return join(storageRoot, "data", sanitizePluginId(pluginId));
}

export function isKnownMarketplaceRecord(value: unknown): value is KnownMarketplaceRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.pluginCount === "number" &&
    isRecord(value.source)
  );
}

export function isInstalledPluginRecord(value: unknown): value is InstalledPluginRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.marketplace === "string" &&
    typeof value.version === "string" &&
    typeof value.installPath === "string" &&
    typeof value.installedAt === "string" &&
    (value.scope === "user" || value.scope === "workspace")
  );
}
