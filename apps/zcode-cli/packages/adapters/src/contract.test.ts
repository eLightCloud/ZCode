import { describe, expect, it } from "vitest";
import { parseMarketplaceSourceInput } from "./index.js";

describe("native adapter public source contract", () => {
  it("keeps a pinned self-hosted Git source without converting its identity", async () => {
    const ref = "1234567890abcdef1234567890abcdef12345678";
    await expect(
      parseMarketplaceSourceInput(`https://git.example.test/team/plugins.git#${ref}`),
    ).resolves.toEqual({ source: "git", url: "https://git.example.test/team/plugins.git", ref });
  });
  it("rejects an empty source before installation rather than selecting a fallback", async () => {
    await expect(parseMarketplaceSourceInput(" ")).rejects.toThrow("Marketplace source is empty");
  });
});
