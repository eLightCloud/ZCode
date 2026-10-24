import { conversationRuntimeCommandSchema, ConversationRuntimeError } from "@zcode/shared";
import type { ProjectId, SessionId } from "@zcode/contracts";
import { textCheckpointSchema } from "@zcode/contracts";
import { projectIdFromDirectory } from "../app/paths.js";
import { resolve } from "node:path";
import { verifyContinuationFiles } from "./continuation-files-check.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

const READ_OPERATION = "00000000-0000-4000-8000-000000000000";
export async function continuationControl(context: ZCodeProtocolAgentServerContext, raw: unknown) {
  const input = conversationRuntimeCommandSchema.parse(raw),
    store = context.deps.sessionStore;
  if (!store?.controlContinuation || !context.sessionResidentPool)
    throw new ConversationRuntimeError("unsupported");
  const directory = context.deps.cwd ?? process.cwd();
  const existing = await store.getSession(input.session as SessionId);
  if (
    existing &&
    (resolve(existing.directory) !== resolve(directory) ||
      existing.workspaceID ||
      existing.parentID)
  )
    throw new ConversationRuntimeError("target_ineligible");
  const target = { directory, projectID: existing?.projectID ?? projectIdFromDirectory(directory) };
  const control = () => store.controlContinuation!(input, target);
  if (input.kind === "close") return control();
  if (input.kind === "stage") {
    const value = textCheckpointSchema.parse(
      JSON.parse(Buffer.from(input.dataBase64, "base64").toString("utf8")),
    );
    const mimeTypes = value.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "file").map((part) => part.mime),
    );
    if (!context.deps.validateContinuationSelection?.(value.modelSelection, mimeTypes))
      throw new ConversationRuntimeError("model_unavailable");
    await verifyContinuationFiles(context, input.session, input.files, value);
  }
  if (["capture", "stage", "apply", "activate", "activateOffline"].includes(input.kind)) {
    const current = await store.controlContinuation(
      { kind: "read", session: input.session, operation: READ_OPERATION },
      target,
    );
    if (current.operation !== input.operation)
      throw new ConversationRuntimeError("operation_conflict");
    if (["apply", "activate", "activateOffline"].includes(input.kind))
      await verifyContinuationFiles(context, input.session, current.files);
    if (["activate", "activateOffline"].includes(input.kind) && current.state !== "active") {
      if (!store.exportTextCheckpoint) throw new ConversationRuntimeError("unsupported");
      // staging 后配置可能变化；授予后仍不能把不支持的模型静默换成默认项。
      const value = await store.exportTextCheckpoint({ sessionID: input.session as SessionId });
      const mimeTypes = value.messages.flatMap((message) =>
        message.parts.filter((part) => part.type === "file").map((part) => part.mime));
      if (!context.deps.validateContinuationSelection?.(value.modelSelection, mimeTypes))
        throw new ConversationRuntimeError("model_unavailable");
    }
    if (
      !["active", "cancelled"].includes(current.state) &&
      !(await context.sessionResidentPool.settleForContinuation(input.session))
    )
      throw new ConversationRuntimeError("busy");
  }
  return control();
}

/** All protocols share the native barrier; protocol responses still settle accepted interactions. */
export async function assertContinuationAdmission(
  context: ZCodeProtocolAgentServerContext,
  method: string,
  params: unknown,
  sessionIds: string[],
) {
  const store = context.deps.sessionStore;
  if (!store?.controlContinuation) return;
  const commands =
    params && typeof params === "object" && "commands" in params ? params.commands : undefined;
  const settlement =
    Array.isArray(commands) &&
    commands.length > 0 &&
    commands.every(
      (c) =>
        c &&
        typeof c === "object" &&
        ["resolveInteraction", "stop", "cancelBackgroundWork"].includes(String(c.type)),
    );
  if (
    settlement ||
    ["session/stop", "session/cancelBackgroundTask", "session/events", "session/debug"].includes(
      method,
    )
  )
    return;
  for (const session of sessionIds) {
    try {
      const state = await store.controlContinuation(
        { kind: "read", session, operation: READ_OPERATION },
        { directory: context.deps.cwd ?? process.cwd(), projectID: "read-only" as ProjectId },
      );
      if (!["active", "cancelled"].includes(state.state))
        throw new ConversationRuntimeError("admission_closed");
    } catch (error) {
      if (error instanceof ConversationRuntimeError && error.code === "not_found") continue;
      throw error;
    }
  }
}
