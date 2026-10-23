import { BUNDLED_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";

import { join } from "node:path";

import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

import { isRecord } from "./helpers.js";

import { createNodeWebFetchHttpClientAdapter } from "../http/index.js";

import { pluginHttpHeaders } from "./http-source-credentials.js";

import {
  MARKETPLACE_JSON_MAX_BYTES,
  MARKETPLACE_JSON_MAX_REDIRECTS,
  MARKETPLACE_JSON_TIMEOUT_MS,
  PLUGIN_ICON_ASSETS_BASE_URL,
  PLUGIN_ICON_SOURCES_FILE,
  PLUGIN_ICON_SOURCES_URL,
  PLUGIN_NAME_PATTERN,
  SOURCE_SHA256_PATTERN,
} from "./marketplace-constants.js";

import { readJsonFileSync, writeJsonFile } from "./marketplace-json-files.js";

import type { PluginIconSourceRecord } from "./marketplace-contracts.js";

export function parsePluginIconSources(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const icon = typeof item.icon === "string" ? item.icon.trim() : "";
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : undefined;
    const sha256 = typeof item.sha256 === "string" ? item.sha256 : undefined;
    if (!PLUGIN_NAME_PATTERN.test(name) || !isSafePluginIconPath(icon)) continue;
    if (mimeType !== undefined && mimeType !== "image/png") continue;
    if (sha256 !== undefined && !SOURCE_SHA256_PATTERN.test(sha256)) continue;
    result.set(name, new URL(icon, PLUGIN_ICON_ASSETS_BASE_URL).href);
  }
  return result;
}

export function applyClaudePluginIcons(
  manifest: Record<string, unknown>,
  iconByPluginName: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!Array.isArray(manifest.plugins) || iconByPluginName.size === 0) return manifest;
  let changed = false;
  const plugins = manifest.plugins.map((plugin) => {
    if (!isRecord(plugin) || typeof plugin.name !== "string") return plugin;
    if (typeof plugin.icon === "string" && plugin.icon.trim().length > 0) return plugin;
    const icon = iconByPluginName.get(plugin.name);
    if (!icon) return plugin;
    changed = true;
    return { ...plugin, icon };
  });
  return changed ? { ...manifest, plugins } : manifest;
}

export function isSafePluginIconPath(icon: string): boolean {
  if (!icon.endsWith(".png") || icon.startsWith("/") || icon.includes("\\")) return false;
  const segments = icon.split("/");
  return segments.length >= 2 && segments.every((segment) => PLUGIN_NAME_PATTERN.test(segment));
}

export async function loadClaudePluginIconSources(
  storageRoot: string,
  operationSignal?: AbortSignal,
): Promise<Map<string, string>> {
  if (BUNDLED_PLUGIN_MARKETPLACE_ID !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) return new Map();
  const cachePath = join(storageRoot, PLUGIN_ICON_SOURCES_FILE);
  const cached = (): Map<string, string> => parsePluginIconSources(readJsonFileSync(cachePath));
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  operationSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 10_000);
  try {
    const response = await requestMarketplaceJson(
      PLUGIN_ICON_SOURCES_URL,
      undefined,
      controller.signal,
      10_000,
    );
    const value = response;
    const parsed = parsePluginIconSources(value);
    if (parsed.size === 0) return cached();
    // 缓存只保留产品需要的字段，不落盘素材源机器路径等 provenance 信息。
    const sanitized: PluginIconSourceRecord[] = [...parsed.entries()].map(([name, iconUrl]) => ({
      name,
      icon: new URL(iconUrl).pathname.slice(new URL(PLUGIN_ICON_ASSETS_BASE_URL).pathname.length),
      mimeType: "image/png",
    }));
    try {
      await writeJsonFile(cachePath, sanitized);
    } catch {
      // 图标缓存写入失败不影响本次 marketplace 主数据刷新。
    }
    return parsed;
  } catch {
    return cached();
  } finally {
    clearTimeout(timeout);
    operationSignal?.removeEventListener("abort", abort);
  }
}

export async function requestMarketplaceJson(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = MARKETPLACE_JSON_TIMEOUT_MS,
): Promise<unknown> {
  const client = createNodeWebFetchHttpClientAdapter({
    env: process.env,
    maxResponseBytes: MARKETPLACE_JSON_MAX_BYTES,
    timeoutMs,
  });
  const credentials = await pluginHttpHeaders(url, headers);
  let currentHeaders = credentials.headers;
  let currentUrl = credentials.url;
  for (let redirectCount = 0; redirectCount <= MARKETPLACE_JSON_MAX_REDIRECTS; redirectCount += 1) {
    const response = await client.request(
      {
        ...(currentHeaders ? { headers: currentHeaders } : {}),
        method: "GET",
        redirect: "manual",
        url: currentUrl,
      },
      { signal },
    );
    if (isMarketplaceJsonRedirectStatus(response.status)) {
      if (credentials.authenticated)
        throw new Error("Authenticated plugin source redirects are forbidden");
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Marketplace redirect is missing Location header: ${currentUrl}`);
      }
      const redirectUrl = new URL(location, currentUrl);
      // 代理/自定义 CA 分支的 http.request 不会执行 redirect:follow；
      // 这里统一有界跟随，并在跨 origin 时清理市场自定义 header，避免凭据泄露给 CDN。
      if (redirectUrl.origin !== new URL(currentUrl).origin) {
        currentHeaders = undefined;
      }
      currentUrl = redirectUrl.toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to fetch marketplace: ${response.status} ${response.statusText}`);
    }
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
  }
  throw new Error(`Marketplace fetch exceeded redirect limit: ${url}`);
}

export function isMarketplaceJsonRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
