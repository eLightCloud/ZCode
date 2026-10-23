import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("runner debug storage rollback", () => {
  it("不再引用已删除的 storage profile 模块", async () => {
    const source = await readFile(new URL("../src/model/runner-debug.ts", import.meta.url), "utf8");

    expect(source).not.toContain("zcode-storage-root");
    const storageSource = await readFile(
      new URL("../src/model/model-io-storage.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('from "./model-io-storage.js"');
    expect(storageSource).not.toContain("zcode-storage-root");
    expect(storageSource).toContain('join(homedir(), ".zcode", "cli"');
  });
});
