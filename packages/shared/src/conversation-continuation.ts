import { z } from "zod";
import { conversationSessionIdSchema } from "./conversation-sync.js";
const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = {
  session: conversationSessionIdSchema,
  operation: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
};
export const conversationContinuationIntentSchema = z
  .object({
    ...identity,
    kind: z.enum(["handoff", "select", "offline"]),
    target: key,
    version: key,
    revision,
    candidates: z.array(key).min(1).max(10000),
  })
  .strict();
export type ConversationContinuationIntent = z.infer<typeof conversationContinuationIntentSchema>;
export const conversationContinuationCancelSchema = z.object(identity).strict();
export const conversationContinuationResultSchema = z
  .object({
    ...identity,
    status: z.enum(["waiting", "ready", "cancelling", "cancelled", "forward_only", "stale"]),
    phase: z.enum(["settling", "preparing", "granted", "ready", "cancelled"]),
    location: key.nullable(),
    version: key.nullable(),
    reason: z.enum(["busy", "changed", "capability", "unavailable"]).optional(),
  })
  .strict();
export type ConversationContinuationResult = z.infer<typeof conversationContinuationResultSchema>;
export const conversationContinuationRecordSchema = z
  .object({
    intent: conversationContinuationIntentSchema,
    result: conversationContinuationResultSchema.nullable(),
  })
  .strict();
export type ConversationContinuationRecord = z.infer<typeof conversationContinuationRecordSchema>;
export interface ConversationContinuationJournal {
  /** Ready offline runtimes remain owners even before they produce a new checkpoint. */
  offlineLocations(
    scope: import("./conversation-sync.js").ConversationCenterPolicy["subjects"][number],
    session: string,
  ): Promise<string[]>;
  /** Serializes cancellation with the actual grant/selection commit. */
  requestCancel(
    scope: import("./conversation-sync.js").ConversationCenterPolicy["subjects"][number],
    session: string,
    operation: string,
  ): Promise<ConversationContinuationRecord>;
  commitOffline(
    scope: import("./conversation-sync.js").ConversationCenterPolicy["subjects"][number],
    session: string,
    operation: string,
  ): Promise<ConversationContinuationRecord>;
  begin(
    scope: import("./conversation-sync.js").ConversationCenterPolicy["subjects"][number],
    input: ConversationContinuationIntent,
  ): Promise<ConversationContinuationRecord>;
  read(
    scope: import("./conversation-sync.js").ConversationCenterPolicy["subjects"][number],
    session: string,
    operation?: string,
  ): Promise<ConversationContinuationRecord | null>;
  finish(
    scope: import("./conversation-sync.js").ConversationCenterPolicy["subjects"][number],
    input: ConversationContinuationResult,
  ): Promise<ConversationContinuationRecord>;
}
const binding = z.object({ location: key, version: key, generation: revision }).strict();
export const conversationContinuationOptionsSchema = z
  .object({
    session: conversationSessionIdSchema,
    revision,
    candidates: z.array(key),
    active: binding.nullable(),
    pending: binding.nullable(),
    handoff: z
      .object({
        id: key,
        phase: z.enum(["requested", "granted", "activated", "cancelled"]),
        source: key,
        target: key,
      })
      .strict()
      .nullable(),
    inflight: conversationContinuationIntentSchema.nullable(),
    targets: z
      .array(
        z
          .object({ location: key, label: z.string().max(256), instanceId: key.optional() })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type ConversationContinuationOptions = z.infer<typeof conversationContinuationOptionsSchema>;
