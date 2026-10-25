export interface ApplicationHttpConfiguration {
  apiOrigin: string;
  publicOrigin: string;
  prefixes: string[];
  csrfCookie: string;
  csrfHeader: string;
}

function origin(value: string, packaged: boolean): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        !packaged &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error("application_http_configuration_invalid");
  }
  return url.origin;
}

/** Trusted startup configuration only; a request cannot supply any of these values. */
export function readApplicationHttpConfiguration(
  environment: Record<string, string | undefined>,
  packaged: boolean,
): ApplicationHttpConfiguration | undefined {
  const target = environment.ZCODE_APPLICATION_ACCOUNT_API;
  if (!target) return undefined;
  const apiOrigin = origin(target, packaged);
  const publicOrigin = origin(environment.ZCODE_APPLICATION_PUBLIC_ORIGIN ?? target, packaged);
  const prefixes = [
    ...new Set([
      "/api/auth",
      ...(environment.ZCODE_APPLICATION_API_PREFIXES ?? "").split(",").filter(Boolean),
    ]),
  ];
  if (
    prefixes.some(
      (prefix) =>
        !/^\/api\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*){0,2}$/.test(prefix) ||
        ["/api/native", "/api/platform", "/api/server-info", "/api/rpc-host-capability"].includes(
          prefix,
        ) ||
        ["/api/platform/", "/api/native/rpc"].some((reserved) => prefix.startsWith(reserved)),
    )
  ) {
    throw new Error("application_http_configuration_invalid");
  }
  const csrfCookie = environment.ZCODE_APPLICATION_CSRF_COOKIE;
  const csrfHeader = environment.ZCODE_APPLICATION_CSRF_HEADER;
  if (
    !csrfCookie ||
    !/^[A-Za-z0-9_-]+$/.test(csrfCookie) ||
    !csrfHeader ||
    !/^[A-Za-z0-9-]+$/.test(csrfHeader) ||
    ["cookie", "authorization", "origin", "host", "referer"].includes(csrfHeader.toLowerCase())
  ) {
    throw new Error("application_http_configuration_invalid");
  }
  return { apiOrigin, publicOrigin, prefixes, csrfCookie, csrfHeader };
}

export function applicationHttpTarget(config: ApplicationHttpConfiguration, path: string): URL {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("#") ||
    [...path].some((char) => char.charCodeAt(0) <= 32)
  )
    throw new Error("application_http_path_rejected");
  const target = new URL(path, config.apiOrigin);
  // 不能让 URL 规范化把一个准入前缀变成另一业务或实例入口。
  if (
    target.origin !== config.apiOrigin ||
    target.pathname + target.search !== path ||
    /%(?:2e|2f|5c|00|0a|0d)/i.test(target.pathname) ||
    !config.prefixes.some(
      (prefix) => target.pathname === prefix || target.pathname.startsWith(prefix + "/"),
    )
  ) {
    throw new Error("application_http_path_rejected");
  }
  return target;
}
