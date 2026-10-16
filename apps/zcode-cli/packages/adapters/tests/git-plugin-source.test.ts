import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  addMarketplace,
  installMarketplacePlugin,
  loadKnownMarketplacesSync,
} from "../src/plugins/index.js";

const execute = promisify(execFile);
const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-pinned-git-"));
  fixtures.push(root);
  const repo = join(root, "remote");
  await mkdir(join(repo, "plugins/pinned/.zcode-plugin"), { recursive: true });
  const git = async (...args: string[]) =>
    (await execute("git", args, { cwd: repo })).stdout.trim();
  await git("init", "--initial-branch=main");
  async function version(value: string) {
    await writeFile(
      join(repo, "plugins/pinned/.zcode-plugin/plugin.json"),
      JSON.stringify({ name: "pinned", version: value, description: "Synthetic fixture" }),
    );
    await writeFile(
      join(repo, "marketplace.json"),
      JSON.stringify({
        name: "pinned-market",
        owner: { name: "Synthetic" },
        plugins: [{ name: "pinned", version: value, source: "./plugins/pinned" }],
      }),
    );
    await git("add", ".");
    await git(
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      value,
    );
    return git("rev-parse", "HEAD");
  }
  const old = await version("1.0.0");
  await git("tag", "v1");
  await version("2.0.0");
  return { root, repo, old, url: pathToFileURL(repo).href, storageRoot: join(root, "storage") };
}

it.each([false, true])("installs a non-HEAD commit with sparse=%s", async (sparse) => {
  const f = await fixture();
  await addMarketplace({
    storageRoot: f.storageRoot,
    expectedId: "pinned-market",
    source: {
      source: "git",
      url: f.url,
      ref: f.old,
      ...(sparse ? { sparsePaths: ["plugins/pinned"] } : {}),
    },
  });
  const result = await installMarketplacePlugin({
    storageRoot: f.storageRoot,
    marketplace: "pinned-market",
    name: "pinned",
  });
  expect(result.installed[0]?.version).toBe("1.0.0");
});

it.each(["ref", "sha"] as const)("pins an individual Git plugin through %s", async (field) => {
  const f = await fixture();
  const market = join(f.root, "catalog");
  await mkdir(market);
  await writeFile(
    join(market, "marketplace.json"),
    JSON.stringify({
      name: "plugin-pin",
      owner: { name: "Synthetic" },
      plugins: [
        {
          name: "pinned",
          source: { source: "git", url: f.url, [field]: f.old, path: "plugins/pinned" },
        },
      ],
    }),
  );
  await addMarketplace({
    storageRoot: f.storageRoot,
    source: { source: "directory", path: market },
  });
  const result = await installMarketplacePlugin({
    storageRoot: f.storageRoot,
    marketplace: "plugin-pin",
    name: "pinned",
  });
  expect(result.installed[0]?.version).toBe("1.0.0");
});

it.each([
  ["main", "2.0.0"],
  ["v1", "1.0.0"],
])("retains branch/tag %s", async (ref, version) => {
  const f = await fixture();
  await addMarketplace({ storageRoot: f.storageRoot, source: { source: "git", url: f.url, ref } });
  const result = await installMarketplacePlugin({
    storageRoot: f.storageRoot,
    marketplace: "pinned-market",
    name: "pinned",
  });
  expect(result.installed[0]?.version).toBe(version);
});

it("rejects a missing commit without replacing the known source", async () => {
  const f = await fixture();
  await addMarketplace({
    storageRoot: f.storageRoot,
    source: { source: "git", url: f.url, ref: f.old },
  });
  const before = loadKnownMarketplacesSync(f.storageRoot);
  await expect(
    addMarketplace({
      storageRoot: f.storageRoot,
      source: { source: "git", url: f.url, ref: "a".repeat(40) },
    }),
  ).rejects.toThrow();
  expect(loadKnownMarketplacesSync(f.storageRoot)).toEqual(before);
});
