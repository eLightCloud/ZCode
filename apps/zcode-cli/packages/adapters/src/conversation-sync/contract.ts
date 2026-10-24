// Existing wire/schema ownership remains in @zcode/contracts; do not copy those DTOs.
export { syncScopeSchema, syncRequestSchema, syncReceiptSchema } from "@zcode/contracts";
export type { SyncScope, SyncRequest, SyncReceipt, ConversationSyncStore } from "@zcode/contracts";

export interface NativeControlIdentityView {
  location: string;
  publicKey: string;
  bound: boolean;
  changed: boolean;
}

/** Only the native outbox writer may bind its persistent installation key. */
export interface NativeControlIdentityPort {
  /** Committed result; pending operations block rekeying without mutation. */
  prepare(enroll?: boolean): NativeControlIdentityView;
  /** Fixed-domain fresh challenge only; unbound keys cannot sign. No private key export. */
  sign(nonce: string): string;
}
