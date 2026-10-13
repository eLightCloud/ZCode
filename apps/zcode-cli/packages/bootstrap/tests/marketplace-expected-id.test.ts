import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zcodePluginsMarketplaceAddParamsSchema } from "@zcode/shared";
import { addZCodePluginMarketplace } from "../src/plugins.js";

describe("public marketplace identity admission", () => {
  it("validates the optional identity at the protocol boundary", () => {
    const input = {
      workspace: { workspacePath: "/synthetic", workspaceKey: "/synthetic" },
      source: "/synthetic/market",
    };
    expect(
      zcodePluginsMarketplaceAddParamsSchema.parse({ ...input, expectedId: "approved" }).expectedId,
    ).toBe("approved");
    expect(
      zcodePluginsMarketplaceAddParamsSchema.safeParse({ ...input, expectedId: "" }).success,
    ).toBe(false);
    expect(zcodePluginsMarketplaceAddParamsSchema.parse(input).expectedId).toBeUndefined();
  });

  it("rejects an unexpected manifest before replacing an existing marketplace", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketplace-identity-"));
    try {
      const source = join(root, "source");
      const storageRoot = join(root, "storage");
      await mkdir(join(source, ".claude-plugin"), { recursive: true });
      const manifest = join(source, ".claude-plugin", "marketplace.json");
      const options = {
        source,
        workingDirectory: root,
        pluginStorageRoot: storageRoot,
        skipUserConfig: true,
      };
      await writeFile(
        manifest,
        JSON.stringify({ name: "original", owner: { name: "synthetic" }, plugins: [] }),
      );
      await addZCodePluginMarketplace({ ...options, expectedId: "original" });
      const knownPath = join(storageRoot, "known_marketplaces.json");
      const original = await readFile(knownPath, "utf8");
      await expect(
        addZCodePluginMarketplace({ ...options, expectedId: "approved" }),
      ).rejects.toThrow("Marketplace declaration id mismatch");
      expect(await readFile(knownPath, "utf8")).toBe(original);
      const preview = await addZCodePluginMarketplace({ ...options, dryRun: true });
      expect(preview.name).toBe("dry-run");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
