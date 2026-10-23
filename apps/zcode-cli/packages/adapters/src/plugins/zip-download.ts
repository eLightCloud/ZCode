import { createNodeWebFetchHttpClientAdapter } from "../http/index.js";

import { pluginHttpHeaders } from "./http-source-credentials.js";

import {
  PluginZipDownloadError,
  ZIP_DENIED_HEADERS,
  ZIP_DOWNLOAD_MAX_BYTES,
  ZIP_DOWNLOAD_TIMEOUT_MS,
  ZIP_MAX_REDIRECTS,
} from "./zip-source-config.js";

export async function downloadZipArchive(input: {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  url: string;
}): Promise<Uint8Array> {
  // agent 会封存用户 shell 代理，ZIP 下载必须和其他应用层 fetch 一样读取 captured proxy fallback。
  const client = createNodeWebFetchHttpClientAdapter({
    env: process.env,
    maxResponseBytes: ZIP_DOWNLOAD_MAX_BYTES,
    timeoutMs: ZIP_DOWNLOAD_TIMEOUT_MS,
  });
  const credentials = await pluginHttpHeaders(input.url, input.headers);
  let currentUrl = credentials.url;
  let currentHeaders = credentials.headers;
  for (let redirectCount = 0; redirectCount <= ZIP_MAX_REDIRECTS; redirectCount += 1) {
    throwIfAborted(input.signal);
    // 受信宿主显式配置的 transportOrigin 已校验协议；远端 manifest 不能开启此路径。
    if (!credentials.authenticated) validateZipDownloadUrl(currentUrl);
    const response = await client.request(
      {
        headers: currentHeaders,
        maxResponseBytes: ZIP_DOWNLOAD_MAX_BYTES,
        method: "GET",
        redirect: "manual",
        url: currentUrl,
      },
      { signal: input.signal },
    );

    if (isRedirectStatus(response.status)) {
      if (credentials.authenticated)
        throw new Error("Authenticated plugin source redirects are forbidden");
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Plugin zip download redirect is missing Location header: ${currentUrl}`);
      }
      const redirectUrl = new URL(location, currentUrl);
      // 跨 CDN origin 继续发送 marketplace 自定义 header 会把内部元数据泄露给跳转目标。
      if (redirectUrl.origin !== new URL(currentUrl).origin) {
        currentHeaders = undefined;
      }
      currentUrl = redirectUrl.toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new PluginZipDownloadError(
        `Failed to download plugin zip: ${response.status} ${response.statusText}`,
        currentUrl,
        response.status,
      );
    }
    return response.body;
  }
  throw new Error(`Plugin zip download exceeded redirect limit: ${input.url}`);
}

export function validateZipHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const [key, value] of Object.entries(headers)) {
    if (ZIP_DENIED_HEADERS.has(key.toLowerCase())) {
      throw new Error(`Plugin zip source header is not allowed: ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`Plugin zip source header must be a string: ${key}`);
    }
  }
}

export function validateZipDownloadUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Plugin zip source URL is invalid: ${value}`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error(`Plugin zip source URL must be HTTPS: ${value}`);
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    isIpv4LoopbackHost(normalized)
  );
}

export function isIpv4LoopbackHost(hostname: string): boolean {
  const match = /^127(?:\.(\d{1,3})){3}$/u.exec(hostname);
  if (!match) return false;
  return hostname
    .split(".")
    .every((part) => Number.parseInt(part, 10) >= 0 && Number.parseInt(part, 10) <= 255);
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Plugin operation cancelled");
    error.name = "AbortError";
    throw error;
  }
}
