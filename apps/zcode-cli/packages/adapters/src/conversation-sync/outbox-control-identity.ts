import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ConversationSyncError } from "@zcode/contracts";

/** Native installation identity. Never returns or logs private key material. */
export function outboxControlIdentity(db: DatabaseSync) {
  function key() {
    let row = db.prepare("select private_key from sync_control_identity where singleton=1").get();
    if (!row) {
      const generated = generateKeyPairSync("ed25519");
      db.prepare("insert into sync_control_identity values(1,?) on conflict do nothing").run(
        generated.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      );
      row = db.prepare("select private_key from sync_control_identity where singleton=1").get()!;
    }
    const privateKey = createPrivateKey({ key: Buffer.from(String(row.private_key), "base64"), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    const bytes = createHash("sha256").update(publicKey).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.toString("hex");
    const location = `host:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return { privateKey, publicKey: publicKey.toString("base64"), location };
  }
  return {
    prepare(enroll = false) {
      db.exec("begin immediate");
      try {
        const identity = key();
        const previous = String(db.prepare("select location from sync_installation where singleton=1").get()!.location);
        const changed = previous !== identity.location;
        if (enroll && changed) {
          if (db.prepare("select 1 from sync_outbox where receipt is null limit 1").get())
            throw new ConversationSyncError("blocked");
          // 旧位置未完成操作不可改写；已确认前序保留，但新身份不能继承旧正代次。
          db.prepare("update sync_bases set generation=0,mode='offline'").run();
          db.prepare("update sync_installation set location=? where singleton=1").run(identity.location);
        }
        db.exec("commit");
        return { location: identity.location, publicKey: identity.publicKey, bound: !changed || enroll, changed: changed && enroll };
      } catch (error) {
        if (db.isTransaction) db.exec("rollback");
        throw error;
      }
    },
    sign(nonce: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new ConversationSyncError("invalid");
      const identity = key();
      if (db.prepare("select location from sync_installation where singleton=1").get()!.location !== identity.location)
        throw new ConversationSyncError("blocked");
      return sign(null, Buffer.from("zcode-native-control-v1:" + nonce), identity.privateKey).toString("base64");
    },
  };
}
