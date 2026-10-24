import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

it("revalidates native config after app startup and preserves the entry through disk resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "required-plugin-app-"));
  const plugin = join(root, "plugin");
  const configPath = join(root, "config.json");
  const dbPath = join(root, "sessions.db");
  const requests: string[] = [];
  let store = await createSqliteSessionStore({ dbPath });
  let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
  const configuration = (enabled = true) =>
    JSON.stringify({
      storage: { dir: join(root, "storage") },
      plugins: { dirs: [plugin], enabledPlugins: { "report@inline": enabled } },
    });
  const options = () => ({
    env: {},
    userConfigPath: configPath,
    sessionStore: store,
    runtimeConfig: {
      memory: { enabled: false },
      workingDirectory: root,
      mcp: { enabled: false, servers: {} },
    },
    modelExecutor: {
      async generateText(request: { messages: unknown }) {
        requests.push(JSON.stringify(request.messages));
        return {
          finishReason: "stop" as const,
          text: "controlled report",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        };
      },
    },
  });
  try {
    await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
    await mkdir(join(plugin, "skills", "daily"), { recursive: true });
    await writeFile(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "report", entrySkill: "daily" }),
    );
    await writeFile(
      join(plugin, "skills", "daily", "SKILL.md"),
      "---\nname: daily\ndescription: controlled test method\n---\nREQUIRED_DISK_METHOD",
    );
    await writeFile(configPath, configuration());
    app = await createRegistryBackedTestApp(options());
    await app.submitPrompt("[report](required-plugin://report@inline) Generate a report");
    expect(requests.some((text) => text.includes("REQUIRED_DISK_METHOD"))).toBe(true);
    await app.runtime.executeTurn("/compact");
    const sessionId = app.sessionId;
    const count = requests.length;
    await writeFile(configPath, configuration(false));
    await expect(app.submitPrompt("Continue")).rejects.toThrow("unavailable");
    expect(requests).toHaveLength(count);
    await app.close();
    app = undefined;
    store.close();
    store = await createSqliteSessionStore({ dbPath });
    app = await createRegistryBackedTestApp({ ...options(), sessionId, resume: true });
    await app.resume();
    await expect(app.submitPrompt("Retry after restart")).rejects.toThrow("unavailable");
    expect(requests).toHaveLength(count);
    await writeFile(configPath, configuration());
    await app.submitPrompt("Retry after enabling the plugin");
    expect(requests.length).toBeGreaterThan(count);
  } finally {
    await app?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
