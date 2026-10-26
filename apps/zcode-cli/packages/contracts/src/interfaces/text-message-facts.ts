import { z } from "zod";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import { conversationArtifactUriSchema } from "@zcode/shared";
import {
  compactBoundaryPayloadSchema,
  CompactTimelineStatus,
  CompactTimelineDisplay,
} from "../compact/index.js";
import { completedToolPartMetadataSchema } from "../tools/tool-result-metadata.js";
import { portableFileMetadata } from "./text-input-facts.js";
import type { TimelineModelSelection } from "./session-message-parts.js";

/** Portable message/part whitelist; checkpoint graph and ledger validation remain with their owner. */
const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();
// Shared 使用独立的 Zod 主版本；复用唯一模型校验器，不复制字段。
export const portableModelSelectionSchema = z.custom<ModelSelection>(
  (value) => modelSelectionSchema.safeParse(value).success,
);
// 原生 timeline 携带显示 label；不能用严格 ModelSelection 误拒绝普通首轮检查点。
const portableTimelineModelSelectionSchema = z.custom<TimelineModelSelection>((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { label, ...selection } = value as Record<string, unknown>;
  return (
    (label === undefined || typeof label === "string") &&
    modelSelectionSchema.safeParse(selection).success
  );
});
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
    origin: z.enum(["real_user", "agent_runtime", "system"]),
    kind: z.enum([
      "user_prompt",
      "assistant_response",
      "system_reminder",
      "compact_summary",
      "todo_reminder",
      "fork_notice",
      "rewind_notice",
      "timeline_event",
    ]),
    source: z.string().optional(),
    uiVisibility: z.enum(["visible", "hidden"]),
    providerVisibility: z.enum(["visible", "hidden"]),
    transcriptVisibility: z.enum(["visible", "hidden"]),
  })
  .strict();
export const portableForkOriginSchema = z
  .object({
    sessionId: id.optional(),
    messageId: id.optional(),
    partId: id.optional(),
    parentSessionId: id.optional(),
    targetMessageId: id.optional(),
  })
  .strict();
const syntheticMetadata = z
  .object({
    source: z.enum(["plugin_reference", "todo_reminder", "fork", "rewind"]),
    visibility: z.enum(["user-visible", "model-only"]),
  })
  .strict();
const userMetadata = z.custom<
  (
    | z.infer<typeof portableFileMetadata>
    | z.infer<typeof syntheticMetadata>
    | Record<never, never>
  ) & { forkOrigin?: z.infer<typeof portableForkOriginSchema> }
>((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { forkOrigin: origin, ...rest } = value as Record<string, unknown>;
  return (
    (origin === undefined || portableForkOriginSchema.safeParse(origin).success) &&
    (portableFileMetadata.safeParse(rest).success ||
      syntheticMetadata.safeParse(rest).success ||
      (origin !== undefined && Object.keys(rest).length === 0))
  );
});
const commonMessage = { id, agent: id, anchor: anchor.optional(), semantics: semantics.optional() };
export const portableMessageInfoSchema = z.discriminatedUnion("role", [
  z
    .object({
      ...commonMessage,
      role: z.literal("user"),
      time: z.object({ created: timestamp }).strict(),
      modelSelection: portableModelSelectionSchema.optional(),
      metadata: userMetadata.optional(),
      synthetic: z.boolean().optional(),
      source: z.enum(["plugin_reference", "todo_reminder", "fork", "rewind"]).optional(),
      visibility: z.enum(["user-visible", "model-only"]).optional(),
      summary: z
        .object({
          title: z.string().optional(),
          body: z.string().optional(),
          diffs: z.array(z.never()),
        })
        .strict()
        .optional(),
      system: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...commonMessage,
      role: z.literal("assistant"),
      parentID: id,
      time: z.object({ created: timestamp, completed: timestamp.optional() }).strict(),
      modelId: id.optional(),
      providerId: id.optional(),
      mode: z.string(),
      planEnabled: z.boolean().optional(),
      cost: z.number().nonnegative(),
      tokens,
      finish: z
        .enum([
          "stop",
          "tool-calls",
          "length",
          "cancelled",
          "error",
          "completed",
          "failed",
          "interrupted",
          "skipped",
        ])
        .optional(),
      error: z
        .object({
          name: id,
          data: z
            .object({
              message: z.string().optional(),
              code: z.union([z.string(), z.number()]).optional(),
              statusCode: z.number().optional(),
              isRetryable: z.boolean().optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
      summary: z.boolean().optional(),
      reasoningLevel: z.string().optional(),
      metadata: z.object({ forkOrigin: portableForkOriginSchema }).strict().optional(),
    })
    .strict(),
]);
const syntheticPartMetadata = z
  .object({
    source: z.enum(["plugin_reference", "todo_reminder", "fork", "rewind"]).optional(),
    visibility: z.enum(["user-visible", "model-only"]).optional(),
    runtimeMessage: z
      .object({
        source: z.enum([
          "plugin_reference",
          "todo_reminder",
          "conversation_fork",
          "rewind_notice",
          "legacy_synthetic",
        ]),
      })
      .strict()
      .optional(),
    forkOrigin: portableForkOriginSchema.optional(),
  })
  .strict();
const portableFilePart = z
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
  .strict();
export const portableMessagePartSchema = z.discriminatedUnion("type", [
  portableFilePart,
  z
    .object({
      id,
      type: z.literal("text"),
      text: z.string(),
      synthetic: z.boolean().optional(),
      ignored: z.boolean().optional(),
      metadata: syntheticPartMetadata.optional(),
      time: z.object({ start: timestamp, end: timestamp.optional() }).strict().optional(),
    })
    .strict(),
  z.object({ id, type: z.literal("step-start") }).strict(),
  z
    .object({
      id,
      type: z.literal("step-finish"),
      reason: z.enum(["stop", "tool-calls", "length", "cancelled", "error"]),
      cost: z.number().nonnegative(),
      tokens,
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal("tool"),
      callID: id,
      tool: id,
      declarationIndex: timestamp.optional(),
      metadata: completedToolPartMetadataSchema.strict().optional(),
      state: z.discriminatedUnion("status", [
        z
          .object({
            status: z.literal("completed"),
            input: z.record(z.unknown()),
            output: z.string(),
            title: z.string(),
            metadata: completedToolPartMetadataSchema.strict(),
            attachments: z.array(portableFilePart).optional(),
            time: z
              .object({ start: timestamp, end: timestamp, compacted: timestamp.optional() })
              .strict(),
          })
          .strict(),
        z
          .object({
            status: z.literal("error"),
            input: z.record(z.unknown()),
            error: z.string(),
            metadata: completedToolPartMetadataSchema.strict().optional(),
            time: z.object({ start: timestamp, end: timestamp }).strict(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal("compaction"),
      auto: z.boolean(),
      trigger: compactBoundaryPayloadSchema.shape.trigger.optional(),
      phase: compactBoundaryPayloadSchema.shape.phase,
      compactReason: compactBoundaryPayloadSchema.shape.compactReason,
      tail_start_id: id.optional(),
      compactBoundary: compactBoundaryPayloadSchema.optional(),
      operationId: id.optional(),
      overflow: z.boolean().optional(),
      timelineStatus: z.nativeEnum(CompactTimelineStatus).optional(),
      timelineDisplay: z.nativeEnum(CompactTimelineDisplay).optional(),
      timelineText: z.string().optional(),
      replace: z.boolean().optional(),
      reason: z.string().optional(),
      boundaryId: id.optional(),
      summaryMessageId: id.optional(),
      preCompactTokenCount: timestamp.optional(),
      postCompactTokenCount: timestamp.optional(),
      truePostCompactTokenCount: timestamp.optional(),
      attempt: timestamp.optional(),
      maxAttempts: timestamp.optional(),
      time: z
        .object({ start: timestamp.optional(), end: timestamp.optional() })
        .strict()
        .optional(),
    })
    .strict(),

  z
    .object({
      id,
      type: z.literal("timeline"),
      timelineType: z.enum(["session_fork", "model_change", "context_compaction"]),
      display: z.enum(["separator", "worklog"]),
      status: z.enum(["completed", "failed", "interrupted", "cancelled"]).optional(),
      anchorMessageId: id.optional(),
      anchorTurnId: id.optional(),
      sourceCommandId: id.optional(),
      originAnchorMessageId: id.optional(),
      originAnchorTurnId: id.optional(),
      parentSessionId: id.optional(),
      targetMessageId: id.optional(),
      targetCheckpointId: id.optional(),
      restoredFileCount: timestamp.optional(),
      fromModel: portableTimelineModelSelectionSchema.optional(),
      toModel: portableTimelineModelSelectionSchema.optional(),
      operationId: id.optional(),
      trigger: compactBoundaryPayloadSchema.shape.trigger.optional(),
      phase: compactBoundaryPayloadSchema.shape.phase,
      compactReason: compactBoundaryPayloadSchema.shape.compactReason,
      boundaryId: id.optional(),
      summaryMessageId: id.optional(),
      preCompactTokenCount: timestamp.optional(),
      postCompactTokenCount: timestamp.optional(),
      truePostCompactTokenCount: timestamp.optional(),
      attempt: timestamp.optional(),
      maxAttempts: timestamp.optional(),
      reason: z.string().optional(),
      time: z
        .object({ start: timestamp.optional(), end: timestamp.optional() })
        .strict()
        .optional(),
    })
    .strict(),
]);
