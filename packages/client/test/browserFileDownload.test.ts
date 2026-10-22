// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { openBrowserFileDownload } from "../src/browserFileDownload.js";
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
});
it("platform uses a native selected writer and reports completion after close", async () => {
  const writer = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
  Object.assign(window, {
    showSaveFilePicker: vi.fn(async () => ({ createWritable: async () => writer })),
  });
  const sink = await openBrowserFileDownload("synthetic.csv");
  await sink.write(new Uint8Array([1]));
  expect(await sink.close()).toBe("completed");
  expect(writer.close).toHaveBeenCalledOnce();
});
it("platform bounds buffering when streaming is unavailable", async () => {
  const sink = await openBrowserFileDownload("synthetic.zip");
  expect(sink.maxBytes).toBe(100 * 1024 ** 2);
  await sink.abort();
});
