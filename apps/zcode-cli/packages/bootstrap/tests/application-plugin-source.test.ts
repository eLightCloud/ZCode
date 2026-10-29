import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveFilesystemPluginRoot,
  collectFilesystemPluginFiles,
} from "../src/app/bundled-plugin-source.js";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const creator = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === "plugin-creator")!;
function source(name = creator.name, version = creator.version) {
  const root = mkdtempSync(join(tmpdir(), "application-plugin-"));
  roots.push(root);
  mkdirSync(join(root, ".zcode-plugin"));
  mkdirSync(join(root, "skills", "plugin-creator"), { recursive: true });
  writeFileSync(join(root, ".zcode-plugin/plugin.json"), JSON.stringify({ name, version }));
  writeFileSync(
    join(root, "skills/plugin-creator/SKILL.md"),
    "synthetic application-owned creator",
  );
  return root;
}
it("uses the application source bytes with the original trusted installation identity", () => {
  const root = source();
  vi.stubEnv("ZCODE_APPLICATION_PLUGIN_SOURCES", JSON.stringify({ "plugin-creator": root }));
  expect(resolveFilesystemPluginRoot(creator)).toBe(root);
  expect(
    collectFilesystemPluginFiles(root, creator).some(
      (file) => file.path === "skills/plugin-creator/SKILL.md",
    ),
  ).toBe(true);
});
it("rejects missing, relative, malformed and mismatched explicit sources without upstream fallback", () => {
  for (const value of [
    "[]",
    "null",
    "bad json",
    JSON.stringify({ "plugin-creator": "relative" }),
    JSON.stringify({ "plugin-creator": join(source(), "absent") }),
    JSON.stringify({ "plugin-creator": source("impostor") }),
    JSON.stringify({ "plugin-creator": source(creator.name, "999.0.0") }),
  ]) {
    vi.stubEnv("ZCODE_APPLICATION_PLUGIN_SOURCES", value);
    expect(() => resolveFilesystemPluginRoot(creator)).toThrow();
  }
});
