import { expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateZCodePluginPath } from "../../src/plugin-management/contract.js";
it("inspects an owned empty directory without installing a marketplace or replacing plugin state", async () => {
  const root = await mkdtemp(join(tmpdir(), "vantage-plugin-contract-"));
  try {
    const result = await validateZCodePluginPath({
      path: root,
      workingDirectory: root,
      pluginStorageRoot: join(root, "owned-storage"),
      skipUserConfig: true,
      userConfigPath: join(root, "missing-user.json"),
      projectConfigPath: join(root, "missing-project.json"),
    });
    expect(result).toEqual([
      expect.objectContaining({ code: "plugin_manifest_not_found", severity: "error" }),
    ]);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
