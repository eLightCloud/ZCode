import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import { z } from "zod";
import type { ProjectId, SessionId, WorkspaceId } from "./shared.js";
import { portableFilePayload, portableFileMetadata } from "./text-input-facts.js";
import { conversationArtifactUriSchema, conversationSessionIdSchema } from "@zcode/shared";

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();
// Shared 使用独立的 Zod 主版本；复用唯一模型校验器，不复制字段。
const selection = z.custom<ModelSelection>(
  (value) => modelSelectionSchema.safeParse(value).success,
);
const tokens = z
  .object({
    total: z.number().nonnegative().optional(),
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    reasoning: z.number().nonnegative(),
    cache: z.object({ read: z.number().nonnegative(), write: z.number().nonnegative() }).strict(),
  })
  .strict();
const anchor = z
  .object({
    turnId: id.optional(),
    origin: z.enum(["realUser", "synthetic"]).optional(),
    sourceCommandId: id.optional(),
    historyRoundCount: timestamp.optional(),
    productTurnId: id.optional(),
    orderedMessageIds: z.array(id).optional(),
    boundaryMessageId: id.optional(),
    goalBoundary: z
      .object({ kind: z.literal("none") })
      .strict()
      .optional(),
  })
  .strict();
const semantics = z
  .object({
    origin: z.enum(["real_user", "agent_runtime"]),
    kind: z.enum(["user_prompt", "assistant_response"]),
    uiVisibility: z.literal("visible"),
    providerVisibility: z.literal("visible"),
    transcriptVisibility: z.literal("visible"),
  })
  .strict();
const commonMessage = { id, agent: id, anchor: anchor.optional(), semantics: semantics.optional() };
const messageInfo = z.discriminatedUnion("role", [
  z
    .object({
      ...commonMessage,
      role: z.literal("user"),
      time: z.object({ created: timestamp }).strict(),
      modelSelection: selection.optional(),
      metadata: portableFileMetadata.optional(),
    })
    .strict(),
  z
    .object({
      ...commonMessage,
      role: z.literal("assistant"),
      parentID: id,
      time: z.object({ created: timestamp, completed: timestamp }).strict(),
      modelId: id.optional(),
      providerId: id.optional(),
      mode: z.string(),
      planEnabled: z.literal(false).optional(),
      cost: z.number().nonnegative(),
      tokens,
      finish: z.literal("stop"),
    })
    .strict(),
]);
const part = z.discriminatedUnion("type", [
  z
    .object({
      id,
      type: z.literal("file"),
      mime: z.string().min(1).max(256),
      filename: z
        .string()
        .max(255)
        .refine((value) => !/[\\/]/.test(value))
        .optional(),
      url: z.string().refine((value) => conversationArtifactUriSchema.safeParse(value).success),
      metadata: z
        .object({
          storageKind: z.literal("artifact"),
          artifactUri: z
            .string()
            .refine((value) => conversationArtifactUriSchema.safeParse(value).success),
          recoverability: z.literal("provider_ready"),
          sizeBytes: z.number().nonnegative().optional(),
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          image: z
            .object({
              maxDimension: z.number().positive().optional(),
              originalWidth: z.number().positive().optional(),
              originalHeight: z.number().positive().optional(),
              width: z.number().positive().optional(),
              height: z.number().positive().optional(),
              resized: z.boolean().optional(),
              transformedSizeBytes: z.number().nonnegative().optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal("text"),
      text: z.string(),
      time: z.object({ start: timestamp, end: timestamp.optional() }).strict().optional(),
    })
    .strict(),
  z.object({ id, type: z.literal("step-start") }).strict(),
  z
    .object({
      id,
      type: z.literal("step-finish"),
      reason: z.literal("stop"),
      cost: z.number().nonnegative(),
      tokens,
    })
    .strict(),
]);
const input = z
  .object({
    id,
    kind: id,
    delivery: z.enum(["startNow", "guide", "queue"]),
    payload: portableFilePayload,
    admittedSequence: timestamp,
    promotedSequence: timestamp.optional(),
    promotedMessageID: id.optional(),
    status: z.enum(["promoted", "cancelled", "discarded"]),
    statusReason: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .optional(),
    time: z.object({ created: timestamp, updated: timestamp }).strict(),
  })
  .strict();

/** 静止文本严格子集；不含路径、环境、凭据、权限或任意 metadata。 */
export const textCheckpointSchema = z
  .object({
    format: z.literal("zcode.text-checkpoint"),
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    session: z
      .object({
        id: z.custom<string>((value) => conversationSessionIdSchema.safeParse(value).success),
        traceID: id.optional(),
        slug: id,
        title: z.string(),
        version: id,
        time: z.object({ created: timestamp, updated: timestamp }).strict(),
      })
      .strict(),
    modelSelection: selection,
    modelSelectionEntryId: id,
    messages: z.array(z.object({ info: messageInfo, parts: z.array(part).min(1) }).strict()).min(2),
    inputs: z.array(input),
  })
  .strict()
  .superRefine((value, context) => {
    const refs = checkpointArtifactUris(value);
    if (
      (value.version < 3 && refs.length > 0) ||
      refs.some((uri) => uri.split("/")[2] !== value.session.id)
    )
      context.addIssue({
        code: "custom",
        message: "Registered same-session files require format v3",
      });
    if (
      value.messages.some((message) =>
        message.parts.some(
          (part) => part.type === "file" && part.url !== part.metadata.artifactUri,
        ),
      )
    )
      context.addIssue({ code: "custom", message: "Inconsistent native artifact identity" });
    if (
      value.version === 1 &&
      (value.messages.some(
        (message) => message.info.role === "user" && message.info.metadata !== undefined,
      ) ||
        value.inputs.some(
          (input) =>
            input.payload.conversationInputIntent &&
            "queueItemId" in input.payload.conversationInputIntent,
        ))
    )
      context.addIssue({ code: "custom", message: "V4 input facts require format v2" });
    const seen = new Set<string>();
    const allMessages = new Map(value.messages.map((message) => [message.info.id, message.info]));
    const issue = () =>
      context.addIssue({ code: "custom", message: "Invalid checkpoint identity" });
    const unique = (key: string) => {
      if (seen.has(key)) issue();
      seen.add(key);
    };
    const ref = (key: string | undefined) => {
      if (key && !allMessages.has(key)) issue();
    };
    for (const [index, { info, parts }] of value.messages.entries()) {
      if (info.role === "user" && info.metadata) {
        const intent = info.metadata.conversationInputIntent;
        if (
          parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("") !== intent.text ||
          (info.anchor?.sourceCommandId !== undefined &&
            info.anchor.sourceCommandId !== intent.sourceCommandId)
        )
          issue();
      }
      unique(`message:${info.id}`);
      if (info.role !== (index % 2 === 0 ? "user" : "assistant")) issue();
      if (info.role === "assistant" && info.parentID !== value.messages[index - 1]?.info.id)
        issue();
      if (!parts.some((item) => item.type === "text")) issue();
      ref(info.anchor?.boundaryMessageId);
      for (const key of info.anchor?.orderedMessageIds ?? []) ref(key);
      for (const item of parts) unique(`part:${item.id}`);
    }
    for (const item of value.inputs) {
      const intent = item.payload.conversationInputIntent;
      // Ledger admittedSequence and V4 admissionSeq are different native sequences.
      // Preserve both; terminal status, not the old intent dispatch hint, prevents replay.
      if (
        intent &&
        "queueItemId" in intent &&
        (intent.text !== item.payload.text || intent.queueItemId !== item.id)
      )
        issue();
      unique(`input:${item.id}`);
      ref(item.promotedMessageID);
      unique(`admission:${item.admittedSequence}`);
      if (item.status === "promoted") {
        if (
          !item.promotedMessageID ||
          allMessages.get(item.promotedMessageID)?.role !== "user" ||
          item.promotedSequence === undefined
        )
          issue();
      } else if (item.promotedMessageID !== undefined || item.promotedSequence !== undefined)
        issue();
    }
    if (value.messages[0]?.info.role !== "user" || value.messages.at(-1)?.info.role !== "assistant")
      issue();
  });

export type TextCheckpoint = z.infer<typeof textCheckpointSchema>;
export function checkpointArtifactUris(value: {
  messages: Array<{
    info: {
      role: string;
      metadata?: {
        conversationInputIntent: { attachments: Array<{ ref: string; previewRef?: string }> };
      };
    };
    parts: Array<{ type: string; url?: string }>;
  }>;
  inputs: Array<{
    payload: {
      conversationInputIntent?: {
        sourceCommandId: string;
        attachments?: Array<{ ref: string; previewRef?: string }>;
      };
      attachments?: Array<{ ref: string; previewRef?: string }>;
    };
  }>;
}) {
  const refs = new Set<string>();
  const add = (items: Array<{ ref: string; previewRef?: string }> | undefined) => {
    for (const item of items ?? []) {
      refs.add(item.ref);
      if (item.previewRef) refs.add(item.previewRef);
    }
  };
  for (const message of value.messages) {
    for (const part of message.parts) if (part.type === "file" && part.url) refs.add(part.url);
    add(message.info.metadata?.conversationInputIntent.attachments);
  }
  for (const item of value.inputs) {
    add(item.payload.attachments);
    add(item.payload.conversationInputIntent?.attachments);
  }
  return [...refs].sort();
}
export type TextCheckpointErrorCode =
  | "invalid_checkpoint"
  | "unsupported_state"
  | "identity_conflict"
  | "session_not_found"
  | "storage_failure";
export class TextCheckpointError extends Error {
  constructor(
    readonly code: TextCheckpointErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Text checkpoint: ${code}`, options);
    this.name = "TextCheckpointError";
  }
}
export interface TextCheckpointStorePort {
  /** 调用方必须已关闭接纳并收口；一致读不证明 runtime 已静止。 */
  exportTextCheckpoint(input: { sessionID: SessionId }): Promise<TextCheckpoint>;
  /** 原子 create-only；不授权、不执行、不覆盖现有身份。 */
  importTextCheckpoint(input: {
    checkpoint: unknown;
    target: { projectID: ProjectId; workspaceID?: WorkspaceId; directory: string };
  }): Promise<void>;
}
