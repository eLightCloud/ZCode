// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFileDownload } from "../src/hooks/useFileDownload.js";
const mocks = vi.hoisted(() => ({ stat: vi.fn(), read: vi.fn(), info: vi.fn(), open: vi.fn() }));
vi.mock("../src/hooks/useServices.js", () => ({
  useServices: () => ({ fileService: { stat: mocks.stat, readFileRange: mocks.read } }),
}));
vi.mock("../src/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openFileDownload: mocks.open }),
}));
vi.mock("../src/logger.js", () => ({ logger: { info: mocks.info, warn: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
});
it("asks for the destination before IO and aborts a workspace file that changed", async () => {
  const order: string[] = [];
  const writer = { write: vi.fn(), close: vi.fn(), abort: vi.fn(async () => {}) };
  mocks.open.mockImplementation(async () => {
    order.push("picker");
    return { write: writer.write, close: writer.close, abort: writer.abort };
  });
  mocks.stat.mockImplementation(async () => {
    order.push("stat");
    return { type: "file", size: 1, mtimeMs: mocks.stat.mock.calls.length };
  });
  mocks.read.mockResolvedValue(new Uint8Array([1]));
  const { result } = renderHook(() => useFileDownload());
  await act(async () => {
    await expect(result.current.downloadFile("/workspace/报告.csv")).rejects.toThrow(
      "file_download_source_changed",
    );
  });
  expect(order[0]).toBe("picker");
  expect(writer.abort).toHaveBeenCalledOnce();
  expect(writer.close).not.toHaveBeenCalled();
});
it("refuses a large buffered fallback before reading any bytes", async () => {
  mocks.open.mockResolvedValue({ maxBytes: 100 * 1024 ** 2, abort: vi.fn(async () => {}) });
  mocks.stat.mockResolvedValue({ type: "file", size: 101 * 1024 ** 2, mtimeMs: 1 });
  const { result } = renderHook(() => useFileDownload());
  await act(async () => {
    await expect(result.current.downloadFile("/workspace/large.zip")).rejects.toThrow(
      "file_download_streaming_required",
    );
  });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.info).not.toHaveBeenCalled();
});
