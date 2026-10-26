import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicationAccountProxy,
  applicationNativeProxy,
  applicationRootPlugin,
} from "./application-root-plugin.mjs";

test("application proxy supports scoped conversation HTTP and rejects broad native/RPC access", () => {
  const env = {
    ZCODE_APPLICATION_ACCOUNT_API: "http://127.0.0.1:3101",
    ZCODE_APPLICATION_API_PREFIXES: "/api/enterprise,/api/native/conversations",
  };
  const proxy = applicationAccountProxy(env);
  assert.equal(proxy["/api/native/conversations"].target, env.ZCODE_APPLICATION_ACCOUNT_API);
  assert.equal(proxy["/api/native/conversations"].changeOrigin, false);
  for (const prefix of [
    "/api/native",
    "/api/native/rpc",
    "/api/native/rpc-host",
    "/api/platform",
    "/api/platform/settings",
    "/api/native/../rpc",
    "/api/native?token=private",
  ]) {
    assert.throws(
      () => applicationAccountProxy({ ...env, ZCODE_APPLICATION_API_PREFIXES: prefix }),
      /invalid-api-prefix/,
    );
  }
});

test("native ingress remains opt-in and preserves the caller origin", () => {
  assert.deepEqual(applicationNativeProxy({}), {});
  const proxy = applicationNativeProxy({ ZCODE_APPLICATION_NATIVE_API: "https://trusted.test" });
  assert.equal(proxy["/ws"].ws, true);
  assert.equal(proxy["/ws"].changeOrigin, false);
  assert.equal(proxy["/api/server-info"].target, "https://trusted.test");
  assert.equal(proxy["/api"], undefined);
  for (const target of [
    "file:///tmp/private",
    "https://key:secret@trusted.test",
    "https://trusted.test/untrusted",
    "https://trusted.test?token=private",
  ]) {
    assert.throws(
      () => applicationNativeProxy({ ZCODE_APPLICATION_NATIVE_API: target }),
      /invalid-native-api/,
    );
  }
});

test("default application preparation is a no-op and keeps public native Root", () => {
  const code = applicationRootPlugin({}).load("\0zcode-application-root");
  assert.match(code, /export async function prepareApplication\(\) \{\}/);
  assert.match(code, /Root as ApplicationRoot/);
  assert.doesNotMatch(code, /account|tenant|token/i);
});

test("external application gets the same public packages as the native host", async () => {
  const { fileURLToPath } = await import("node:url");
  const plugin = applicationRootPlugin({
    ZCODE_APPLICATION_ROOT_MODULE: fileURLToPath(
      new URL("../packages/web/src/main.tsx", import.meta.url),
    ),
  });
  const aliases = plugin.config().resolve.alias;
  assert.ok(
    aliases.some(
      (alias) =>
        alias.find.test("@zcode/client") &&
        alias.replacement.endsWith("packages/client/src/index.ts"),
    ),
  );
  assert.ok(!aliases.some((alias) => alias.find.test("@zcode/shared/model-config")));
  assert.ok(
    aliases.some(
      (alias) =>
        alias.find.test("@zcode/client/browser-file-download") &&
        alias.replacement.endsWith("packages/client/src/browserFileDownload.ts"),
    ),
  );
  const allowed = [],
    watched = [];
  plugin.configureServer({
    config: { server: { fs: { allow: allowed } } },
    watcher: { add: (value) => watched.push(value) },
  });
  assert.equal(allowed[0], watched[0]);
});
