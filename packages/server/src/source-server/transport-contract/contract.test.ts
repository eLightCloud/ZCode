// @vitest-environment node
import { expect, it } from "vitest";
import { throwIfAborted, readLastJsonLine } from "./contract.js";
it("preserves the existing public capability and failure boundary", async () => {
  expect(readLastJsonLine('noise\n{"ok":true}\nwarning')).toEqual({ ok: true });
  expect(() => readLastJsonLine("warning only")).toThrow("no JSON");
  const c = new AbortController();
  c.abort();
  expect(() => throwIfAborted(c.signal)).toThrow("canceled");
});
