import { checkpointArtifactUris, type TextCheckpoint } from "@zcode/contracts";
import { ConversationRuntimeError, type ConversationFile } from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import { continuationContent } from "./continuation-content.js";

export async function verifyContinuationFiles(
  context: ZCodeProtocolAgentServerContext,
  session: string,
  files: ConversationFile[] = [],
  checkpoint?: TextCheckpoint,
) {
  const refs = checkpoint ? checkpointArtifactUris(checkpoint) : files.map((file) => file.uri);
  if (
    refs.length !== files.length ||
    new Set(refs).size !== refs.length ||
    refs.some((uri) => !files.some((file) => file.uri === uri))
  )
    throw new ConversationRuntimeError("artifact_manifest");
  for (const file of files) {
    const actual = await continuationContent(context, { kind: "read", session, uri: file.uri });
    if (
      actual.file.sha256 !== file.sha256 ||
      actual.file.bytes !== file.bytes ||
      actual.file.contentType !== file.contentType
    )
      throw new ConversationRuntimeError("artifact_integrity");
  }
}
