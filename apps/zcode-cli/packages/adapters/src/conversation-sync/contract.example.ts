import type { ConversationSyncOutbox } from "./index.js";

/** Native caller only. Enrollment must wait for original pending uploads to finish. */
export function proveInstallation(outbox: ConversationSyncOutbox, freshNonce: string) {
  const identity = outbox.controlIdentity(true);
  return {
    location: identity.location,
    publicKey: identity.publicKey,
    signature: outbox.signControlChallenge(freshNonce),
  };
}
