import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const MIN_TOKEN_LENGTH = 32;
const CONFIG_ENV = "ZCODE_PLUGIN_SOURCE_CREDENTIALS_FILE";

interface Binding {
  origin: string;
  pathPrefix: string;
  token: string;
  transportOrigin?: string;
}

/** Host-only credentials: never accept secrets from plugin metadata or persist returned headers. */
export async function pluginHttpHeaders(
  url: string,
  headers?: Record<string, string>,
): Promise<{
  headers: Record<string, string> | undefined;
  authenticated: boolean;
  url: string;
}> {
  const configured = process.env[CONFIG_ENV];
  if (!configured) return { headers, authenticated: false, url };
  let bindings: Binding[];
  try {
    if (!isAbsolute(configured)) throw new Error();
    const metadata = await lstat(configured);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error();
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error();
    const file = await open(configured, "r");
    try {
      const actual = await file.stat();
      if (
        actual.ino !== metadata.ino ||
        actual.dev !== metadata.dev ||
        actual.size > MAX_CREDENTIAL_FILE_BYTES
      )
        throw new Error();
      const parsed: unknown = JSON.parse(await file.readFile("utf8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("version" in parsed) ||
        parsed.version !== 1 ||
        !("bindings" in parsed) ||
        !Array.isArray(parsed.bindings)
      )
        throw new Error();
      bindings = parsed.bindings.map((entry: unknown): Binding => {
        if (
          !entry ||
          typeof entry !== "object" ||
          !("origin" in entry) ||
          typeof entry.origin !== "string" ||
          !("pathPrefix" in entry) ||
          typeof entry.pathPrefix !== "string" ||
          !("token" in entry) ||
          typeof entry.token !== "string"
        )
          throw new Error();
        const origin = new URL(entry.origin);
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
        if (
          (origin.protocol !== "https:" && !(loopback && origin.protocol === "http:")) ||
          origin.origin !== entry.origin ||
          origin.username ||
          origin.password ||
          !entry.pathPrefix.startsWith("/") ||
          !entry.pathPrefix.endsWith("/") ||
          /[?#%\\]/u.test(entry.pathPrefix) ||
          new URL(entry.pathPrefix, origin).pathname !== entry.pathPrefix ||
          entry.token.length < MIN_TOKEN_LENGTH ||
          /[\r\n]/u.test(entry.token)
        )
          throw new Error();
        let transportOrigin: string | undefined;
        if ("transportOrigin" in entry) {
          if (typeof entry.transportOrigin !== "string") throw new Error();
          const transport = new URL(entry.transportOrigin);
          const insecure =
            "allowInsecureTransport" in entry && entry.allowInsecureTransport === true;
          if (
            transport.origin !== entry.transportOrigin ||
            transport.username ||
            transport.password ||
            (transport.protocol !== "https:" && !(insecure && transport.protocol === "http:"))
          )
            throw new Error();
          transportOrigin = transport.origin;
        }
        return {
          origin: entry.origin,
          pathPrefix: entry.pathPrefix,
          token: entry.token,
          transportOrigin,
        };
      });
    } finally {
      await file.close();
    }
  } catch {
    // 配置错误不可透出 JSON 输入、token 或私有路径。
    throw new Error("Plugin source credentials configuration is invalid");
  }
  const target = new URL(url);
  const matching = bindings.filter(
    (binding) => target.origin === binding.origin && target.pathname.startsWith(binding.pathPrefix),
  );
  if (matching.length > 1) throw new Error("Plugin source credentials binding is ambiguous");
  const binding = matching[0];
  if (!binding) return { headers, authenticated: false, url };
  return {
    headers: { ...headers, Authorization: `Bearer ${binding.token}` },
    authenticated: true,
    url: binding.transportOrigin ? binding.transportOrigin + target.pathname + target.search : url,
  };
}
