import { applicationRootPlugin } from "./application-root-plugin.mjs";
import { test, after } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { applicationBrandPlugin } from "./application-brand-plugin.mjs";
import {
  resolveDesktopProductIdentity,
  resolveWindowsAppUserModelIdForFlavor,
} from "../packages/desktop/scripts/desktop-product-identity.mjs";
const fixture = await mkdtemp(resolve(tmpdir(), "application-brand-test-"));
const manifest = resolve(fixture, "brand.json");
await mkdir(resolve(fixture, "assets"));
await writeFile(manifest, JSON.stringify({ schemaVersion: 1, applicationName: "Example Product" }));
await writeFile(
  resolve(fixture, "source.svg"),
  '<svg viewBox="0 0 256 256"><path fill="currentColor" d="M0 0H256V256Z"/></svg>',
);
for (const name of [
  "mark-black.svg",
  "mark-white.svg",
  "favicon.svg",
  "favicon.ico",
  "apple-touch-icon.png",
  "app-icon-192.png",
  "app-icon-512.png",
  "maskable-512.png",
  "site.webmanifest",
]) {
  await writeFile(resolve(fixture, "assets", name), "synthetic public asset");
}
after(async () => rm(fixture, { recursive: true, force: true }));
test("actual desktop HTML startup uses product geometry without changing readiness", async () => {
  const plugin = await applicationBrandPlugin({ ZCODE_APPLICATION_BRAND_MANIFEST: manifest });
  const html = await readFile(
    new URL("../packages/desktop/src/renderer/index.html", import.meta.url),
    "utf8",
  );
  const result = plugin.transformIndexHtml(html);
  assert.match(result.html, /d="M0 0H256V256Z"/);
  assert.doesNotMatch(result.html, /M134\.4|viewBox="0 0 256 218"/);
  assert.match(result.html, /zcode-react-startup-ready/);
  assert.match(result.html, /aria-busy="true"/);
});
test("unconfigured build remains native; invalid configuration fails", async () => {
  assert.equal(await applicationBrandPlugin({}), null);
  await assert.rejects(
    () => applicationBrandPlugin({ ZCODE_APPLICATION_BRAND_MANIFEST: "relative.json" }),
    /absolute-manifest-required/,
  );
  await assert.rejects(
    () =>
      applicationBrandPlugin({ ZCODE_APPLICATION_BRAND_MANIFEST: resolve("missing-brand.json") }),
    /configuration-unavailable/,
  );
});
test("title, startup mark and emitted public assets share one product source", async () => {
  const plugin = await applicationBrandPlugin({ ZCODE_APPLICATION_BRAND_MANIFEST: manifest });
  plugin.configResolved({ base: "./" });
  const result = plugin.transformIndexHtml(
    '<head><title>ZCode</title></head><svg class="startup-logo" viewBox="0 0 256 218"><path d="native" /></svg>',
  );
  assert.match(result.html, /<title>Example Product<\/title>/);
  assert.match(result.html, /viewBox="0 0 256 256"/);
  assert.doesNotMatch(result.html, /d="native"/);
  assert.equal(
    result.tags.find((tag) => tag.attrs.rel === "icon").attrs.href,
    "./application-brand/favicon.svg",
  );
  const emitted = [];
  plugin.generateBundle.call({ emitFile: (asset) => emitted.push(asset) });
  assert.equal(emitted.length, 9);
  let handler;
  plugin.configureServer({
    config: { server: { fs: { allow: [] } } },
    middlewares: {
      use: (fn) => {
        handler = fn;
      },
    },
  });
  let status = 200;
  let content;
  handler(
    { url: "/application-brand/../../brand.json" },
    {
      set statusCode(value) {
        status = value;
      },
      end(value) {
        content = value;
      },
    },
    () => {},
  );
  assert.equal(status, 404);
  assert.equal(content, undefined);
});
test("branded preview and production have distinct installation identities", () => {
  const env = {
    ZCODE_APPLICATION_NAME: "Example",
    ZCODE_APPLICATION_ID: "com.example.app",
    ZCODE_APPLICATION_EXECUTABLE: "example",
    ZCODE_APPLICATION_PACKAGE: "example",
  };
  const production = resolveDesktopProductIdentity({ ...env, ZCODE_ENV: "production" });
  const preview = resolveDesktopProductIdentity({ ...env, ZCODE_ENV: "test" });
  assert.equal(production.productName, "Example");
  assert.equal(preview.productName, "Example Preview");
  assert.notEqual(production.appId, preview.appId);
  assert.equal(
    resolveWindowsAppUserModelIdForFlavor("preview", { isPackaged: true }, env),
    preview.appId,
  );
  assert.throws(
    () => resolveDesktopProductIdentity({ ZCODE_APPLICATION_NAME: "Example" }),
    /incomplete-desktop-identity/,
  );
});

test("application shell is selected at build time before Intl and remains optional", () => {
  assert.match(
    applicationRootPlugin({}).load("\0zcode-application-root"),
    /Fragment as ApplicationShell/,
  );
  const code = applicationRootPlugin({ ZCODE_APPLICATION_SHELL_MODULE: manifest }).load(
    "\0zcode-application-root",
  );
  assert.match(code, /export \{ ApplicationShell \}/);
  assert.ok(code.includes(manifest));
  assert.throws(
    () => applicationRootPlugin({ ZCODE_APPLICATION_SHELL_MODULE: "relative.tsx" }),
    /shell-unavailable/,
  );
});
