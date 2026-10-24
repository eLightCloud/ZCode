import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectTrace } from "./contract.js";
it("reports an empty explicitly isolated source without inventing trace facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "vantage-debug-contract-"));
  try {
    const result = await inspectTrace("owned-missing-trace", {
      logDir: root,
      eventPath: join(root, "missing.jsonl"),
      dbPath: join(root, "missing.sqlite"),
    });
    expect(result.traceId).toBe("owned-missing-trace");
    expect(result.sessions).toEqual([]);
    expect(result.timeline).toEqual([]);
    expect(result.sources.every((source) => source.recordCount === 0)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
