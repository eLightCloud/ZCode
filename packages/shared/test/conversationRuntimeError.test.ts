import { expect, it } from "vitest";
import {
  ConversationRuntimeError,
  conversationRuntimeErrorCode,
} from "../src/conversation-runtime.js";

it("preserves the native not_found/busy code inside a numeric JSON-RPC envelope", () => {
  const remote = Object.assign(new Error("opaque transport message"), {
    code: -32000,
    data: { code: "not_found" },
  });
  expect(conversationRuntimeErrorCode(remote)).toBe("not_found");
  expect(conversationRuntimeErrorCode({ ...remote, data: { code: "busy" } })).toBe("busy");
  expect(conversationRuntimeErrorCode(new ConversationRuntimeError("model_unavailable"))).toBe(
    "model_unavailable",
  );
});
it("does not reflect arbitrary error text, paths or credentials as a domain code", () => {
  expect(
    conversationRuntimeErrorCode({ code: -32000, data: { code: "SYNTHETIC_PRIVATE_VALUE/path" } }),
  ).toBe("unavailable");
  expect(conversationRuntimeErrorCode(new Error("SYNTHETIC_PRIVATE_VALUE"))).toBe("unavailable");
});
