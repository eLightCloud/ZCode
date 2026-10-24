import { expect, it } from "vitest";
import {
  conversationScopeSchema,
  conversationSessionIdSchema,
  conversationContinuationIntentSchema,
} from "../../src/conversation-native-protocol/contract.js";
it("keeps native identity validation strict and never admits browser privilege fields", () => {
  expect(conversationSessionIdSchema.safeParse("..").success).toBe(false);
  expect(
    conversationScopeSchema.safeParse({
      tenant: "10000000-0000-4000-8000-000000000001",
      subject: "10000000-0000-4000-8000-000000000002",
      credential: "owned-synthetic",
    }).success,
  ).toBe(false);
  const intent = {
    session: "owned-session",
    operation: "10000000-0000-4000-8000-000000000003",
    kind: "offline",
    target: "owned-target",
    version: "owned-version",
    revision: 1,
    candidates: ["owned-version"],
  };
  expect(conversationContinuationIntentSchema.safeParse(intent).success).toBe(true);
  expect(
    conversationContinuationIntentSchema.safeParse({ ...intent, barrierClosed: true }).success,
  ).toBe(false);
});
