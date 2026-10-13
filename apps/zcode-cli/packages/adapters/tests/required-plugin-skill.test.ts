import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createNodeSkillAdapter } from "../src/skills/index.js";
import { createNodePluginAdapter } from "../src/plugins/index.js";

it("uses native plugin discovery and the current installation, enablement and entry skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "required-plugin-"));
  try {
    const pluginRoot = join(root, "plugin");
    const skillPath = join(pluginRoot, "skills", "daily", "SKILL.md");
    const manifest = join(pluginRoot, ".claude-plugin", "plugin.json");
    await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "skills", "daily"), { recursive: true });
    await writeFile(manifest, JSON.stringify({ name: "report", entrySkill: "daily" }));
    await writeFile(
      skillPath,
      "---\nname: daily\ndescription: synthetic business method\n---\nUse controlled source data.",
    );
    const config = {
      dirs: [pluginRoot],
      enabled: true,
      enabledPlugins: {} as Record<string, boolean>,
      options: {},
      extraKnownMarketplaces: {},
      suppressedBuiltins: [],
    };
    const plugins = createNodePluginAdapter({ storageRoot: join(root, "storage") });
    let disabledPaths: string[] = [];
    let conflict = false;
    const adapter = createNodeSkillAdapter({
      homeDirectory: join(root, "home"),
      resolveRequiredPlugins: async (workingDirectory) => {
        const outcome = await plugins.discoverPlugins({
          config,
          storageRoot: join(root, "storage"),
          workingDirectory,
          env: {},
        });
        if (conflict && outcome.plugins[0])
          outcome.plugins.push({
            ...outcome.plugins[0],
            id: "report@another-source",
          });
        return { outcome, disabledPaths };
      },
    });
    const request = { pluginId: "report@inline", workingDirectory: root };
    const loaded = await adapter.loadRequiredPluginSkill(request);
    expect(loaded.metadata.pluginId).toBe("report@inline");
    expect(loaded.metadata.qualifiedName).toBe("report:daily");
    expect(loaded.content).toContain("Use controlled source data.");
    config.enabledPlugins["report@inline"] = false;
    await expect(adapter.loadRequiredPluginSkill(request)).rejects.toThrow("plugin_unavailable");
    config.enabledPlugins["report@inline"] = true;
    conflict = true;
    await expect(adapter.loadRequiredPluginSkill(request)).rejects.toThrow("plugin_conflict");
    conflict = false;
    disabledPaths = [skillPath];
    await expect(adapter.loadRequiredPluginSkill(request)).rejects.toThrow();
    disabledPaths = [];
    await expect(adapter.loadRequiredPluginSkill({ ...request, maxBytes: 5 })).rejects.toThrow(
      "entry_invalid",
    );
    await writeFile(manifest, JSON.stringify({ name: "report", entrySkill: "missing" }));
    await expect(adapter.loadRequiredPluginSkill(request)).rejects.toThrow();
    await writeFile(manifest, JSON.stringify({ name: "report", entrySkill: "daily" }));
    let reads = 0;
    const racing = createNodeSkillAdapter({
      homeDirectory: join(root, "home"),
      resolveRequiredPlugins: async (workingDirectory) => {
        const outcome = await plugins.discoverPlugins({
          config,
          storageRoot: join(root, "storage"),
          workingDirectory,
          env: {},
        });
        if (++reads === 2) outcome.plugins[0]!.enabled = false;
        return { outcome };
      },
    });
    await expect(racing.loadRequiredPluginSkill(request)).rejects.toThrow("configuration_changed");
    await rm(pluginRoot, { recursive: true });
    await expect(adapter.loadRequiredPluginSkill(request)).rejects.toThrow("plugin_unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
