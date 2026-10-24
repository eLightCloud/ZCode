import {
  checkpointArtifactUris,
  ConversationSyncError,
  type TextCheckpoint,
  type ConversationFileStore,
  type SyncScope,
} from "@zcode/contracts";
import {
  conversationContentResultSchema,
  type ConversationContentResult,
  type ConversationFile,
} from "@zcode/shared";
import { createHash } from "node:crypto";

/** Exact producer references only. Bytes must be durably accepted before their version. */
export async function captureRegisteredFiles(
  store: ConversationFileStore | undefined,
  scope: SyncScope,
  session: string,
  checkpoint: TextCheckpoint,
  read: ((uri: string) => Promise<ConversationContentResult>) | undefined,
): Promise<ConversationFile[]> {
  const refs = checkpointArtifactUris(checkpoint);
  if (!refs.length) return [];
  if (!read || !store) throw new ConversationSyncError("blocked");
  const files: ConversationFile[] = [];
  for (const uri of refs) {
    if (uri.split("/")[2] !== session) throw new ConversationSyncError("invalid");
    const value = conversationContentResultSchema.parse(await read(uri));
    if (value.file.uri !== uri || value.dataBase64 === undefined)
      throw new ConversationSyncError("storage");
    const bytes = Buffer.from(value.dataBase64, "base64");
    if (
      bytes.length !== value.file.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== value.file.sha256
    )
      throw new ConversationSyncError("storage");
    await store.put(scope, value.file, bytes);
    files.push(value.file);
  }
  return files;
}
