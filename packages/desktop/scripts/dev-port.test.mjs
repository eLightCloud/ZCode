import assert from "node:assert/strict";
import test from "node:test";
import { resolveDesktopDevPort } from "./dev-port.mjs";

test("desktop development retains the native default and accepts a deployment port", () => {
  assert.equal(resolveDesktopDevPort({}), 5174);
  assert.equal(resolveDesktopDevPort({ ZCODE_DESKTOP_DEV_PORT: "3105" }), 3105);
});

test("invalid deployment ports fail before waiting for the renderer", () => {
  for (const value of ["", "0", "80", "65536", "3105.5", "abc", "3e3"]) {
    assert.throws(() => resolveDesktopDevPort({ ZCODE_DESKTOP_DEV_PORT: value }), {
      message: "desktop.development.invalid-port",
    });
  }
});
