// @vitest-environment node
import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPaths } from "./contract.js";
it("preserves the existing public capability and failure boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-archive-contract-"));
  try {
    await writeFile(join(root, "a"), "a");
    await writeFile(join(root, "b"), "b");
    expect(await hashPaths(root, ["b", "a"])).toEqual(await hashPaths(root, ["a", "b"]));
    await expect(hashPaths(root, ["missing"])).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
