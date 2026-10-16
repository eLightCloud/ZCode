import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pluginHttpHeaders } from "../src/plugins/http-source-credentials.js";
import {
  addMarketplace,
  installMarketplacePlugin,
  loadKnownMarketplacesSync,
} from "../src/plugins/index.js";
import { resolveZipPluginSource } from "../src/plugins/zip-source.js";

const TOKEN = "synthetic-native-credential-for-tests-only";
const ZIP = Buffer.from(
  "UEsDBBQAAAAAAAAAIQDE5Op+UwAAAFMAAAAZAAAALnpjb2RlLXBsdWdpbi9wbHVnaW4uanNvbnsibmFtZSI6ICJmaXh0dXJlIiwgInZlcnNpb24iOiAiMS4wLjAiLCAiZGVzY3JpcHRpb24iOiAiU3ludGhldGljIHByaXZhdGUgZml4dHVyZSJ9UEsBAhQDFAAAAAAAAAAhAMTk6n5TAAAAUwAAABkAAAAAAAAAAAAAAIABAAAAAC56Y29kZS1wbHVnaW4vcGx1Z2luLmpzb25QSwUGAAAAAAEAAQBHAAAAigAAAAAA",
  "base64",
);
const SHA = createHash("sha256").update(ZIP).digest("hex");
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-private-source-"));
  roots.push(root);
  const received: Array<{ url: string; authorization?: string }> = [];
  let origin = "";
  const server = createServer((request, response) => {
    received.push({
      url: request.url!,
      authorization: request.headers.authorization,
    });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.url?.includes("redirect")) {
      response.writeHead(302, { location: origin + "/public/leak" }).end();
      return;
    }
    if (request.url?.endsWith(".zip")) {
      response.writeHead(200).end(ZIP);
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name: "private-fixture",
        owner: { name: "Synthetic" },
        plugins: [
          {
            name: "fixture",
            version: "1.0.0",
            source: {
              source: "url",
              type: "zip",
              url: origin + "/private/package.zip",
              sha256: SHA,
            },
          },
        ],
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  const config = join(root, "credentials.json");
  async function configure(token = TOKEN) {
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        bindings: [{ origin, pathPrefix: "/private/", token }],
      }),
      { mode: 0o600 },
    );
    vi.stubEnv("ZCODE_PLUGIN_SOURCE_CREDENTIALS_FILE", config);
  }
  return {
    root,
    origin,
    config,
    received,
    configure,
    storageRoot: join(root, "native"),
  };
}

it("authenticates native marketplace and ZIP reads without persisting credentials", async () => {
  const f = await fixture();
  const source = {
    source: "url" as const,
    url: f.origin + "/private/marketplace.json",
  };
  await expect(addMarketplace({ storageRoot: f.storageRoot, source })).rejects.toThrow();
  expect(loadKnownMarketplacesSync(f.storageRoot)).toEqual([]);
  await f.configure();
  await addMarketplace({
    storageRoot: f.storageRoot,
    source,
    expectedId: "private-fixture",
  });
  const result = await installMarketplacePlugin({
    storageRoot: f.storageRoot,
    marketplace: "private-fixture",
    name: "fixture",
  });
  expect(result.installed[0]?.version).toBe("1.0.0");
  expect(
    f.received.some(
      (request) => request.url.endsWith(".zip") && request.authorization === `Bearer ${TOKEN}`,
    ),
  ).toBe(true);
  expect(JSON.stringify(loadKnownMarketplacesSync(f.storageRoot))).not.toContain(TOKEN);
  expect(
    await readFile(join(f.storageRoot, "marketplaces/private-fixture/marketplace.json"), "utf8"),
  ).not.toContain(TOKEN);
});

it("never sends a credential outside its exact origin and path, and reads rotations", async () => {
  const f = await fixture();
  await f.configure();
  for (const url of [
    f.origin + "/public/catalog",
    f.origin + "/private-other/catalog",
    "https://other.example.test/private/catalog",
    f.origin + "/private/../public/catalog",
  ])
    expect((await pluginHttpHeaders(url)).authenticated).toBe(false);
  await f.configure("synthetic-rotated-credential-for-tests-only");
  expect((await pluginHttpHeaders(f.origin + "/private/catalog")).headers?.Authorization).toContain(
    "synthetic-rotated",
  );
});

it("rejects authenticated catalog and ZIP redirects without visiting the destination", async () => {
  const f = await fixture();
  await f.configure();
  await expect(
    addMarketplace({
      storageRoot: f.storageRoot,
      source: { source: "url", url: f.origin + "/private/redirect" },
    }),
  ).rejects.toThrow(/redirects are forbidden/u);
  await expect(
    resolveZipPluginSource({
      url: f.origin + "/private/redirect.zip",
      sha256: SHA,
    }),
  ).rejects.toThrow(/redirects are forbidden/u);
  expect(f.received.some((request) => request.url.startsWith("/public/"))).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "rejects readable or symlinked credential files with safe diagnostics",
  async () => {
    const f = await fixture();
    await f.configure();
    await chmod(f.config, 0o644);
    await expect(pluginHttpHeaders(f.origin + "/private/catalog")).rejects.toThrow(
      "configuration is invalid",
    );
    await chmod(f.config, 0o600);
    const link = join(f.root, "link.json");
    await symlink(f.config, link);
    vi.stubEnv("ZCODE_PLUGIN_SOURCE_CREDENTIALS_FILE", link);
    await expect(pluginHttpHeaders(f.origin + "/private/catalog")).rejects.toThrow(
      "configuration is invalid",
    );
  },
);
