// @vitest-environment node
import { expect, it } from "vitest";
import { indicatorCopy, indicatorHtml } from "./contract.js";
it("preserves the existing public capability and failure boundary", async () => {
  expect(indicatorCopy("en-US", "Example").text).toContain("Example");
  expect(indicatorHtml("en-US", "<Example>")).toContain("&lt;Example&gt;");
  expect(indicatorHtml("en-US", "<Example>")).not.toContain("<Example>");
});
