import { mkdtemp } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { it } from "vitest";
import { vi } from "vitest";
import { resolveZCodeAgentSpawnCwd } from "../src/zcode-agent/zcodeAgentSpawnCwd.js";
import { DatabaseSync } from "node:sqlite";
import { prepareTasksIndexStorage } from "../src/project-storage/startup.js";

it("shares fallback behavior for missing paths, files and ENOTDIR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-spawn-cwd-"));
  try {
    const file = join(dir, "file");
    await writeFile(file, "x");
    for (const path of [file, join(file, "child"), join(dir, "missing")]) {
      expect(
        await resolveZCodeAgentSpawnCwd({
          requestedCwd: path,
          workspacePath: path,
          spawnFallbackCwd: dir,
        }),
      ).toMatchObject({ cwd: dir, usedFallback: true, cwdExists: true });
    }
    expect(
      await resolveZCodeAgentSpawnCwd({
        requestedCwd: file,
        workspacePath: dir,
        spawnFallbackCwd: dir,
      }),
    ).toMatchObject({ cwd: file, usedFallback: false, cwdExists: false });
    expect(
      await resolveZCodeAgentSpawnCwd({
        requestedCwd: file,
        workspacePath: file,
        spawnFallbackCwd: join(dir, "missing"),
      }),
    ).toMatchObject({ cwd: file, usedFallback: false, cwdExists: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("startup receives old settings before marking the project migration complete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-projects-"));
  const path = join(dir, "tasks.sqlite");
  try {
    await prepareTasksIndexStorage(path, () => {}, {
      lastWorkspaceSession: [
        { kind: "local", workspacePath: "/saved-project", workspacePurpose: "project" },
      ],
    });
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare("SELECT root_path FROM project_roots").all()).toEqual([
        { root_path: "/saved-project" },
      ]);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("falls back for an inaccessible project, without treating it as a database permission error", async () => {
  const probe = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
    .mockResolvedValueOnce({ isDirectory: () => true });
  expect(
    await resolveZCodeAgentSpawnCwd(
      { requestedCwd: "/old", workspacePath: "/old", spawnFallbackCwd: "/fallback" },
      probe,
    ),
  ).toMatchObject({ cwd: "/fallback", usedFallback: true });
});
