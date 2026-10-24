import { createHash } from "node:crypto";
import {
  conversationContentRequestSchema,
  conversationFileSchema,
  ConversationRuntimeError,
} from "@zcode/shared";
import type { SessionId, ProjectId } from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Explicit native URI reads only. Restores require the same persisted closed operation. */
export async function continuationContent(context: ZCodeProtocolAgentServerContext, raw: unknown) {
  const input = conversationContentRequestSchema.parse(raw),
    artifacts = context.deps.continuationArtifacts;
  if (!artifacts?.readFixedArtifact) throw new ConversationRuntimeError("artifact_unsupported");
  const uri = input.kind === "read" ? input.uri : input.file.uri;
  if (uri.split("/")[2] !== input.session) throw new ConversationRuntimeError("artifact_identity");
  if (input.kind === "restore") {
    const store = context.deps.sessionStore;
    if (!store?.controlContinuation) throw new ConversationRuntimeError("artifact_unsupported");
    const state = await store.controlContinuation(
      { kind: "read", session: input.session, operation: input.operation },
      { directory: context.deps.cwd ?? process.cwd(), projectID: "read-only" as ProjectId },
    );
    if (
      state.operation !== input.operation ||
      !["closing", "closed", "staged"].includes(state.state)
    )
      throw new ConversationRuntimeError("artifact_unprepared");
    if (!artifacts.restoreFixedArtifact) throw new ConversationRuntimeError("artifact_unsupported");
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (
      bytes.length !== input.file.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== input.file.sha256
    )
      throw new ConversationRuntimeError("artifact_integrity");
    await artifacts.restoreFixedArtifact({
      sessionId: input.session as SessionId,
      uri,
      bytes,
      contentType: input.file.contentType,
    });
  }
  const result = await artifacts.readFixedArtifact({ sessionId: input.session as SessionId, uri });
  const file = conversationFileSchema.parse({
    uri,
    bytes: result.bytes.length,
    contentType: result.contentType,
    sha256: createHash("sha256").update(result.bytes).digest("hex"),
  });
  if (
    input.kind === "restore" &&
    (file.sha256 !== input.file.sha256 ||
      file.bytes !== input.file.bytes ||
      file.contentType !== input.file.contentType)
  )
    throw new ConversationRuntimeError("artifact_integrity");
  context.logger?.info("Native registered file verified", {
    event: "conversation.file.native",
    sessionId: input.session,
    ...(input.kind === "restore" ? { operationId: input.operation } : {}),
    outcome: input.kind,
  });
  return {
    file,
    ...(input.kind === "read" ? { dataBase64: Buffer.from(result.bytes).toString("base64") } : {}),
  };
}
