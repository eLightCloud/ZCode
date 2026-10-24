import { expect, it } from "vitest";
import { zcodeProtocolErrorCodes } from "@zcode/shared";
import {
  parseParams,
  ProtocolRequestError,
  requireSession,
} from "../../src/zcode-protocol/contract.js";

it("reports invalid protocol parameters using the established error code", () => {
  try {
    parseParams(
      {
        parse() {
          throw new Error("owned invalid fixture");
        },
      },
      {},
    );
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolRequestError);
    expect((error as ProtocolRequestError).code).toBe(-32602);
  }
});
it("keeps a missing runtime unavailable without inventing or creating a session", () => {
  const sessions = new Map<string, { owner: string }>();
  try {
    requireSession({ sessions, deps: {} }, "owned-missing-runtime");
    throw new Error("expected unavailable");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolRequestError);
    expect((error as ProtocolRequestError).code).toBe(zcodeProtocolErrorCodes.sessionUnavailable);
  }
  expect(sessions.size).toBe(0);
});
