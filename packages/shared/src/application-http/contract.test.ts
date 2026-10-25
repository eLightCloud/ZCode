import { expect, it } from "vitest";
import { applicationHttpRequestSchema } from "./contract.js";
import { applicationReadExample } from "./contract.example.js";
it("rejects credential and destination overrides at the wire boundary", () => {
  expect(applicationHttpRequestSchema.parse(applicationReadExample)).toEqual(
    applicationReadExample,
  );
  for (const extra of [
    { url: "https://other.invalid" },
    { headers: { Cookie: "owned synthetic" } },
    { origin: "https://other.invalid" },
  ]) {
    expect(
      applicationHttpRequestSchema.safeParse({ ...applicationReadExample, ...extra }).success,
    ).toBe(false);
  }
});
