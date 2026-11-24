import { expect, it } from "vitest";
import { applicationHttpRequestSchema } from "./contract.js";
import { applicationReadExample } from "./contract.example.js";
it("accepts request bodies up to 28 MiB and rejects the next byte", () => {
  const limit = 28 * 1024 * 1024;
  const request = { ...applicationReadExample, method: "POST", contentType: "application/json" };
  expect(
    applicationHttpRequestSchema.safeParse({ ...request, body: new ArrayBuffer(limit) }).success,
  ).toBe(true);
  expect(
    applicationHttpRequestSchema.safeParse({ ...request, body: new ArrayBuffer(limit + 1) })
      .success,
  ).toBe(false);
});
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
