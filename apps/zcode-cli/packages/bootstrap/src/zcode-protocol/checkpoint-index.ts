import {
  type ConversationIndexProjection,
  buildZCodeTaskSearchText,
  conversationIndexProjectionSchema,
  formatModelPickerValue,
  generateTraceId,
  resolveZCodeVisibleSessionTitle,
} from "@zcode/shared";
import type {
  TextCheckpoint,
  MessageWithParts,
  MessageId,
  PartId,
  SessionId,
  ModelId,
  ModelProviderId,
  MessagePart,
} from "@zcode/contracts";
import { mapMessageWithParts } from "./message-mapper.js";

/** Read projection of the same immutable text package; never creates/resumes an App. */
export function checkpointIndexProjection(
  checkpoint: TextCheckpoint,
  directory: string,
  cliFacts?: NonNullable<ConversationIndexProjection["cliFacts"]>,
) {
  const sessionID = checkpoint.session.id as SessionId;
  const messages = checkpoint.messages.map((message) => {
    // The existing product mapper does not consume ledger anchors; avoid recasting
    // their portable IDs as runtime execution identities for a read projection.
    const { anchor: _anchor, ...sourceInfo } = message.info;
    const info =
      sourceInfo.role === "user"
        ? { ...sourceInfo, id: sourceInfo.id as MessageId, sessionID }
        : {
            ...sourceInfo,
            id: sourceInfo.id as MessageId,
            sessionID,
            modelId: sourceInfo.modelId as ModelId | undefined,
            providerId: sourceInfo.providerId as ModelProviderId | undefined,
            parentID: sourceInfo.parentID as MessageId,
            path: { cwd: directory, root: directory },
          };
    const stored: MessageWithParts = {
      info,
      parts: message.parts.map((part) => ({
        ...part,
        id: part.id as PartId,
        sessionID,
        messageID: message.info.id as MessageId,
      }) as MessagePart),
    };
    return mapMessageWithParts(stored);
  });
  const model =
    messages.findLast((message) => message.info.model)?.info.model ?? checkpoint.modelSelection;
  const last = checkpoint.messages.at(-1)!.info;
  const projected = conversationIndexProjectionSchema.safeParse({
    ...(cliFacts ? { cliFacts } : {}),
    meta: {
      taskId: checkpoint.session.id,
      ...(checkpoint.session.parentID ? {forkedFromTaskId:checkpoint.session.parentID} : {}),
      traceId: checkpoint.session.traceID ?? generateTraceId(checkpoint.session.id),
      title: resolveZCodeVisibleSessionTitle({ title: checkpoint.session.title, messages }),
      createdAt: checkpoint.session.time.created,
      updatedAt: checkpoint.session.time.updated,
      mode: last.role === "assistant" ? last.mode : "default",
      status: "completed",
      model: formatModelPickerValue(model),
    },
    searchableText: buildZCodeTaskSearchText({ messages, projection: { target: null } }),
  });
  // Older text packages may name a mode no longer represented in the task shell.
  // 保存正文仍有效；不能用默认 mode 伪造已完成的索引恢复。
  return projected.success ? projected.data : undefined;
}
