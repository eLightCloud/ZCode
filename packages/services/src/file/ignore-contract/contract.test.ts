// @vitest-environment node
import { expect, it } from "vitest";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceFileSearchIgnore } from "./contract.js";
it("preserves the existing public capability and failure boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-ignore-contract-"));
  try {
    const preview = await readWorkspaceFileSearchIgnore(root);
    expect(preview.source).toBe("template");
    await expect(access(join(root, ".zcodeignore"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
