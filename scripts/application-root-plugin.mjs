import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

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
               await applicationExtension.prepareApplication(options);
             }
           }`
        : "export async function prepareApplication() {}";
      return shellExport + preparationExport + (entry
        ? `export { default as ApplicationRoot } from ${JSON.stringify(entry)};`
        : `export { Root as ApplicationRoot } from ${JSON.stringify(
            createRequire(new URL("../packages/web/package.json", import.meta.url)).resolve(
              "@zcode/ui",
            ),
          )};`);
    },
    configureServer(server) {
      if (entry) server.config.server.fs.allow.push(dirname(entry));
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
  return { "/api/auth": { target, changeOrigin: false } };
}

export function applicationNativeProxy(env) {
  const target = env.ZCODE_APPLICATION_NATIVE_API;
  if (!target) return {};
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    throw new Error("application-root.invalid-native-api");
  }
  return {
    "/ws": { target, ws: true, changeOrigin: false },
    "/api/server-info": { target, changeOrigin: false },
    "/api/rpc-host-capability": { target, changeOrigin: false },
    "/api/native/locations": { target, changeOrigin: false },
  };
}
