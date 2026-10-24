import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { createConversationSyncOutbox } from "./index.js";
import { proveInstallation } from "./contract.example.js";

it("public outbox facade keeps unbound installations unable to prove ownership", () => {
  const outbox = createConversationSyncOutbox(":memory:");
  try {
    const nonce = randomBytes(32).toString("base64url");
    expect(() => outbox.signControlChallenge(nonce)).toThrow("blocked");
    const proof = proveInstallation(outbox, nonce);
    expect(proof.location).toBe(outbox.location());
    expect(Object.keys(proof).sort()).toEqual(["location", "publicKey", "signature"]);
    expect(() => outbox.signControlChallenge("not-a-native-challenge")).toThrow("invalid");
  } finally { outbox.close(); }
});
