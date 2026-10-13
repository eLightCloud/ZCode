import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { matchesServerToken, matchesServerTokenHash } from "../src/node/serverToken.js";

it("matches only an exact non-empty instance token without failing on UTF-8 length differences", () => {
  const token = "synthetic-instance-token";
  expect(matchesServerToken(token, token)).toBe(true);
  expect(matchesServerToken("synthetic-instance-tokem", token)).toBe(false);
  expect(matchesServerToken(undefined, token)).toBe(false);
  expect(matchesServerToken("", "")).toBe(false);
  expect(matchesServerToken("é", "x")).toBe(false);
});

it("a digest validates the credential but cannot itself be used as the credential", () => {
  const token = "synthetic-high-entropy-instance-credential";
  const digest = createHash("sha256").update(token).digest("hex");
  expect(matchesServerTokenHash(token, digest)).toBe(true);
  expect(matchesServerTokenHash(digest, digest)).toBe(false);
  expect(matchesServerTokenHash("wrong-credential", digest)).toBe(false);
  expect(matchesServerTokenHash(token, "malformed")).toBe(false);
});
