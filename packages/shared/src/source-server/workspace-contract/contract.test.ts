// @vitest-environment node
import { expect, it } from "vitest";
import {
  isPublicZCodeErrorCode,
  publicZCodeErrorCodeSchema,
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
} from "./contract.js";
it("preserves the existing public capability and failure boundary", async () => {
  expect(isPublicZCodeErrorCode(SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE)).toBe(true);
  expect(isPublicZCodeErrorCode("untrusted-new-authority")).toBe(false);
  expect(publicZCodeErrorCodeSchema.safeParse("untrusted-new-authority").success).toBe(false);
});
