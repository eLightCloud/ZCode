import { expect, it } from "vitest";
import { buildLocalMediaPreviewUrl, LOCAL_MEDIA_PREVIEW_SCHEME } from "./contract.js";
it("keeps the public local preview URL encoding and scheme", () => {
  const value = new URL(buildLocalMediaPreviewUrl("/owned/a b#c.mp4"));
  expect(value.protocol).toBe(LOCAL_MEDIA_PREVIEW_SCHEME + ":");
  expect(value.hostname).toBe("local");
  expect(value.searchParams.get("path")).toBe("/owned/a b#c.mp4");
});
