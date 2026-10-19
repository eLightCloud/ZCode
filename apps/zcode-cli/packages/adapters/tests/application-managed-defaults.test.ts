import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ensureDefaultPluginMarketplaces,
  loadApplicationDefaultsSync,
  loadKnownMarketplacesSync,
} from "../src/plugins/marketplace.js";
import {
  effectiveDefaultMarketplaces,
  parseApplicationDefaults,
} from "../src/plugins/application-managed-defaults.js";
import { DEFAULT_PLUGIN_MARKETPLACES } from "@zcode/shared";

let roots: string[] = [];

afterEach(async () => {
  roots = [];
});

async function storageRoot(seed: unknown) {
  const root = await mkdtemp(join(tmpdir(), "managed-defaults-"));
  roots.push(root);
  if (seed !== undefined) {
    await writeFile(join(root, "known_marketplaces.json"), JSON.stringify(seed), "utf8");
  }
  return root;
}

const managedSeed = {
  version: 1,
  marketplaces: [
    {
      id: "product-catalog",
      source: "https://catalog.example.test/marketplace.json",
      name: "product-catalog",
      description: "Product-managed catalog",
      pluginCount: 0,
    },
  ],
};

it("without managed defaults the upstream built-ins stay the effective set", () => {
  expect(parseApplicationDefaults(undefined)).toBeNull();
  expect(parseApplicationDefaults({ version: 2, marketplaces: [] })).toBeNull();
  expect(effectiveDefaultMarketplaces(null)).toEqual(DEFAULT_PLUGIN_MARKETPLACES);
});

it("managed defaults replace the built-in set and removed built-ins are not re-added", async () => {
  const root = await storageRoot({
    version: 1,
    marketplaces: [
      {
        id: "user-source",
        source: { source: "url", url: "https://user.example.test/marketplace.json" },
        name: "user-source",
        description: "",
        addedAt: "2026-01-01T00:00:00.000Z",
        pluginCount: 3,
      },
    ],
    applicationDefaults: managedSeed,
  });
  expect(loadApplicationDefaultsSync(root)).toEqual(managedSeed.marketplaces);
  const known = ensureDefaultPluginMarketplaces(root);
  const ids = known.map((record) => record.id).sort();
  // 只补产品托管集合；内置官方来源与 Claude 官方源都不再自动补回，用户来源保留。
  expect(ids).toEqual(["product-catalog", "user-source"]);
});

it("ensure keeps managed defaults across refresh and restart rounds", async () => {
  const root = await storageRoot({
    version: 1,
    marketplaces: [],
    applicationDefaults: managedSeed,
  });
  ensureDefaultPluginMarketplaces(root);
  const second = ensureDefaultPluginMarketplaces(root);
  expect(second.map((record) => record.id)).toEqual(["product-catalog"]);
  const persisted = JSON.parse(
    await readFile(join(root, "known_marketplaces.json"), "utf8"),
  );
  expect(persisted.applicationDefaults).toEqual(managedSeed);
});

it("invalid managed payloads fall back to upstream behavior", async () => {
  const root = await storageRoot({
    version: 1,
    marketplaces: [],
    applicationDefaults: { version: 1, marketplaces: [{ id: "", source: "" }] },
  });
  expect(loadApplicationDefaultsSync(root)).toBeNull();
  const known = ensureDefaultPluginMarketplaces(root);
  expect(known.map((record) => record.id)).toEqual(
    DEFAULT_PLUGIN_MARKETPLACES.map((marketplace) => marketplace.id),
  );
});

it("refresh writes preserve the managed defaults field", async () => {
  const root = await storageRoot({
    version: 1,
    marketplaces: [],
    applicationDefaults: managedSeed,
  });
  ensureDefaultPluginMarketplaces(root);
  const known = loadKnownMarketplacesSync(root);
  expect(known).toHaveLength(1);
  const persisted = JSON.parse(
    await readFile(join(root, "known_marketplaces.json"), "utf8"),
  );
  expect(persisted.marketplaces).toHaveLength(1);
  expect(persisted.applicationDefaults).toEqual(managedSeed);
});
