// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllGlobals());
it("passes a real File to the native file resolver and rejects an arbitrary object", async () => {
  const getPathForFile = vi.fn(() => "/owned/selected.txt");
  vi.stubGlobal("window", { zcode: { getPathForFile } });
  const { desktopBrowserPlatformBridge } =
    await import("../src/renderer/src/desktopBrowserPlatformBridge.js");
  expect(desktopBrowserPlatformBridge.getPathForFile?.({ name: "untrusted-name" })).toBeNull();
  expect(getPathForFile).not.toHaveBeenCalled();
  const file = new File(["owned synthetic"], "selected.txt");
  expect(desktopBrowserPlatformBridge.getPathForFile?.(file)).toBe("/owned/selected.txt");
  expect(getPathForFile).toHaveBeenCalledWith(file);
});
