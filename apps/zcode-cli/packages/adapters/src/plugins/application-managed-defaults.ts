/**
 * Application-managed marketplace defaults persisted in known_marketplaces.json.
 *
 * 受信应用装配通过部署初始化写入 `applicationDefaults`，替换（而非追加）内置默认
 * 集合；被替换的内置来源不再参与自动补齐。本模块只做通用解析与回退，不包含任何
 * 企业名、租户或远端地址；写入方是部署 / 装配初始化，不是运行中的用户操作。
 */
import {
  DEFAULT_PLUGIN_MARKETPLACES,
  type DefaultPluginMarketplace,
} from "@zcode/shared";

export const APPLICATION_DEFAULTS_VERSION = 1;

function parseMarketplaceSeed(value: unknown): DefaultPluginMarketplace | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.source !== "string" ||
    !record.source
  ) {
    return null;
  }
  const name = typeof record.name === "string" && record.name ? record.name : record.id;
  return {
    id: record.id,
    source: record.source,
    name,
    description:
      typeof record.description === "string" ? record.description : "",
    pluginCount: typeof record.pluginCount === "number" ? record.pluginCount : 0,
    ...(typeof record.lastUpdated === "string" ? { lastUpdated: record.lastUpdated } : {}),
  };
}

/**
 * Parse the persisted `applicationDefaults` field; absent or invalid payloads fall
 * back to `null` so callers keep upstream default behavior instead of failing.
 */
export function parseApplicationDefaults(value: unknown): DefaultPluginMarketplace[] | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== APPLICATION_DEFAULTS_VERSION || !Array.isArray(record.marketplaces)) {
    return null;
  }
  const marketplaces = record.marketplaces
    .map(parseMarketplaceSeed)
    .filter((item): item is DefaultPluginMarketplace => item !== null);
  return marketplaces.length > 0 ? marketplaces : null;
}

/**
 * The effective seed set for ensure/补齐 paths: managed defaults when present,
 * upstream built-ins otherwise. Replacement must never silently re-add a removed
 * built-in source that the application assembly has exited.
 */
export function effectiveDefaultMarketplaces(
  applicationDefaults: DefaultPluginMarketplace[] | null,
): readonly DefaultPluginMarketplace[] {
  return applicationDefaults ?? DEFAULT_PLUGIN_MARKETPLACES;
}
