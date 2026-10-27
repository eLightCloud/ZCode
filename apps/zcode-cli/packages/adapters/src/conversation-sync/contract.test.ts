import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { createConversationSyncOutbox } from "./index.js";
import { proveInstallation } from "./contract.example.js";
import { conversationCenterPolicySchema } from "@zcode/shared";

it("capacity policy has no account enable switch or allowlist", () => {
  const limits = { maxCheckpointBytes: 65536, maxSubjectBytes: 8388608, maxVersionsPerSession: 64 };
  expect(conversationCenterPolicySchema.parse(limits)).toEqual(limits);
  for (const obsolete of [{ enabled: false }, { enabled: true }, { subjects: [] }]) {
    expect(conversationCenterPolicySchema.safeParse({ ...limits, ...obsolete }).success).toBe(
      false,
    );
  }
});

it("public outbox facade keeps unbound installations unable to prove ownership", () => {
  const outbox = createConversationSyncOutbox(":memory:");
  try {
    const nonce = randomBytes(32).toString("base64url");
    expect(() => outbox.signControlChallenge(nonce)).toThrow("blocked");
    const proof = proveInstallation(outbox, nonce);
    expect(proof.location).toBe(outbox.location());
    expect(Object.keys(proof).sort()).toEqual(["location", "publicKey", "signature"]);
    expect(() => outbox.signControlChallenge("not-a-native-challenge")).toThrow("invalid");
  } finally {
    outbox.close();
  }
});
