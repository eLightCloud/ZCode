import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function applicationRootPlugin(env) {
  const entry = env.ZCODE_APPLICATION_ROOT_MODULE;
  const shell = env.ZCODE_APPLICATION_SHELL_MODULE;
  if (shell && (!isAbsolute(shell) || !existsSync(shell))) {
    throw new Error("application-root.shell-unavailable");
  }
  if (entry && (!isAbsolute(entry) || !existsSync(entry))) {
    throw new Error("application-root.module-unavailable");
  }
  return {
    name: "zcode-application-root",
    config() {
      if (!entry && !shell) return;
      // 外部可信源码不在 pnpm 工作区，包解析须与实际宿主使用同一公开入口。
      return {
        resolve: {
          alias: [
            "@zcode/client",
            "@zcode/client/browser-file-download",
            "@zcode/services",
            "@zcode/shared",
            "@zcode/ui",
          ].map((id) => ({
            find: new RegExp("^" + id + "$"),
            replacement: (() => {
              const manifest = new URL(
                "../packages/" + id.split("/")[1] + "/package.json",
                import.meta.url,
              );
              const subpath = id.split("/").slice(2).join("/");
              const publicEntry = JSON.parse(readFileSync(manifest, "utf8")).exports[
                subpath ? "./" + subpath : "."
              ];
              return fileURLToPath(new URL(publicEntry, manifest));
            })(),
          })),
        },
      };
    },
    resolveId(id) {
      return id === "virtual:zcode-application-root" ? "\0zcode-application-root" : null;
    },
    load(id) {
      if (id !== "\0zcode-application-root") return null;
      const shellExport = shell
        ? `export { ApplicationShell } from ${JSON.stringify(shell)};`
        : `export { Fragment as ApplicationShell } from "react";`;
      const preparationExport = entry
        ? `import * as applicationExtension from ${JSON.stringify(entry)};
           export async function prepareApplication(options) {
             if (typeof applicationExtension.prepareApplication === "function") {
               return await applicationExtension.prepareApplication(options);
             }
           }`
        : "export async function prepareApplication() {}";
      return (
        shellExport +
        preparationExport +
        (entry
          ? `export { default as ApplicationRoot } from ${JSON.stringify(entry)};`
          : `export { Root as ApplicationRoot } from ${JSON.stringify(
              createRequire(new URL("../packages/web/package.json", import.meta.url)).resolve(
                "@zcode/ui",
              ),
            )};`)
      );
    },
    configureServer(server) {
      if (entry) {
        const applicationRoot = resolve(dirname(entry), "..");
        server.config.server.fs.allow.push(applicationRoot);
        // 新生成的兄弟模块也必须使原生解析缓存失效，不能只观察组合根。
        server.watcher.add(applicationRoot);
      }
      if (shell) server.config.server.fs.allow.push(dirname(shell));
    },
  };
}

export function applicationAccountProxy(env) {
  const target = env.ZCODE_APPLICATION_ACCOUNT_API;
  if (!target) return {};
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("application-root.invalid-account-api");
  }
  const prefixes = [
    "/api/auth",
    ...(env.ZCODE_APPLICATION_API_PREFIXES ?? "").split(",").filter(Boolean),
  ];
  const reserved = ["/api/server-info", "/api/rpc-host-capability", "/api/native"];
  for (const prefix of prefixes) {
    if (!/^\/api\/[a-z][a-z0-9-]*$/.test(prefix) || reserved.includes(prefix)) {
      throw new Error("application-root.invalid-api-prefix");
    }
  }
  return Object.fromEntries(prefixes.map((prefix) => [prefix, { target, changeOrigin: false }]));
}

export function applicationNativeProxy(env) {
  const target = env.ZCODE_APPLICATION_NATIVE_API;
  if (!target) return {};
  const url = new URL(target);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("application-root.invalid-native-api");
  }
  return {
    "/ws": { target, ws: true, changeOrigin: false },
    "/api/server-info": { target, changeOrigin: false },
    "/api/rpc-host-capability": { target, changeOrigin: false },
    "/api/native/locations": { target, changeOrigin: false },
  };
}
