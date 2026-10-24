import { describe, expect, it } from "vitest";
import { sanitizeProviderEndpoint, sanitizeTelemetryError } from "./index.js";

describe("CLI telemetry public safety contract", () => {
  it("projects an endpoint without credentials, query or fragment", () => {
    const endpoint = sanitizeProviderEndpoint("https://fixture-user:fixture-pass@example.test/v1?token=fixture-token#private");
    expect(endpoint).toMatchObject({ origin: "https://example.test", route: "/v1" });
    expect(JSON.stringify(endpoint)).not.toMatch(/fixture-user|fixture-pass|fixture-token|private/);
  });
  it("keeps the failure kind while removing credentials from the public error projection", () => {
    const failure = sanitizeTelemetryError(new TypeError("Authorization: Bearer fixture-secret"));
    expect(failure.type).toBe("TypeError");
    expect(failure.message).toContain("{redacted}");
    expect(JSON.stringify(failure)).not.toContain("fixture-secret");
  });
});
