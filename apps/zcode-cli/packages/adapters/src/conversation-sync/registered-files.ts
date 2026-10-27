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

/** Read and verify immutable local producer references without requiring a network. */
export async function readRegisteredFiles(
  session: string, checkpoint: TextCheckpoint,
  read: ((uri: string) => Promise<ConversationContentResult>) | undefined,
): Promise<Array<{ file: ConversationFile; bytes: Uint8Array }>> {
  const refs = checkpointArtifactUris(checkpoint);
  if (!refs.length) return [];
  if (!read) throw new ConversationSyncError("blocked");
  const result: Array<{ file: ConversationFile; bytes: Uint8Array }> = [];
  for (const uri of refs) {
    if (uri.split("/")[2] !== session) throw new ConversationSyncError("invalid");
    const value = conversationContentResultSchema.parse(await read(uri));
    if (value.file.uri !== uri || value.dataBase64 === undefined) throw new ConversationSyncError("storage");
    const bytes = Buffer.from(value.dataBase64, "base64");
    if (bytes.length !== value.file.bytes || createHash("sha256").update(bytes).digest("hex") !== value.file.sha256)
      throw new ConversationSyncError("storage");
    result.push({ file: value.file, bytes });
  }
  return result;
}

/** Exact producer references only. Bytes must be durably accepted before their version. */
export async function captureRegisteredFiles(
  store: ConversationFileStore | undefined, scope: SyncScope, session: string,
  checkpoint: TextCheckpoint, read: ((uri: string) => Promise<ConversationContentResult>) | undefined,
): Promise<ConversationFile[]> {
  const values = await readRegisteredFiles(session, checkpoint, read);
  if (values.length && !store) throw new ConversationSyncError("blocked");
  for (const { file, bytes } of values) await store!.put(scope, file, bytes);
  return values.map(value => value.file);
}
