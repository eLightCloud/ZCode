import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import { z } from "zod";
import type { ProjectId, SessionId, WorkspaceId } from "./shared.js";

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
    payload: z
      .object({
        text: z.string(),
        conversationInputIntent: z
          .object({
            sourceCommandId: id,
          })
          .strict()
          .optional(),
      })
      .strict(),
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
    version: z.literal(1),
    session: z
      .object({
        id,
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
