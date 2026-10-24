import { describe, expect, it } from "vitest";
import { applyNetworkEgressEnv, createNodeHttpClientAdapter } from "./index.js";

describe("native HTTP and network public boundary", () => {
  it("keeps the explicit native proxy policy over inherited tool environment", () => {
    const env = { HTTPS_PROXY: "http://inherited.test:8080" };
    const result = applyNetworkEgressEnv(env, { network: { httpProxy: "http://configured.test:8080" }, sourceEnv: {}, platform: "linux" });
    expect(result.HTTPS_PROXY).toBe("http://configured.test:8080");
    expect(result.HTTP_PROXY).toBe("http://configured.test:8080");
  });
  it("rejects a local file URL before dispatching HTTP", async () => {
    await expect(createNodeHttpClientAdapter({ env: {} }).request({ url: "file:///tmp/owned-fixture" })).rejects.toThrow();
  });
});
