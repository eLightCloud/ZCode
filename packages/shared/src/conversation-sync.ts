import { z } from "zod";
import { zcodeTaskMetaSchema } from "./validation.js";

export const conversationScopeSchema = z
  .object({
    tenant: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    subject: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
export const conversationCenterPolicySchema = z
  .object({
    enabled: z.boolean(),
    subjects: z.array(conversationScopeSchema).max(10000),
    maxCheckpointBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    maxSubjectBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxVersionsPerSession: z.number().int().positive().max(10000),
  })
  .strict();
export const conversationCenterConfigurationSchema = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    policy: conversationCenterPolicySchema,
  })
  .strict();
export type ConversationCenterPolicy = z.infer<typeof conversationCenterPolicySchema>;
export type ConversationCenterConfiguration = z.infer<typeof conversationCenterConfigurationSchema>;

/** Unique Host-owned actions. Absence in old packages means unknown, never false. */
export const conversationIndexFactsSchema = z
  .object({
    titleOverride: z.string().max(4096).nullable(),
    archived: z.boolean(),
    deleted: z.boolean(),
    pinned: z.boolean().optional(),
  })
  .strict();
export type ConversationIndexFacts = z.infer<typeof conversationIndexFactsSchema>;

/** Transport remains opaque; only the native checkpoint codec interprets its body. */
export const conversationIndexProjectionSchema = z
  .object({
    meta: zcodeTaskMetaSchema
      .pick({
        taskId: true,
        traceId: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        mode: true,
        model: true,
        status: true,
      })
      .strict(),
    searchableText: z.string().max(200000),
  })
  .strict();
export const conversationCheckpointResultSchema = z
  .object({
    dataBase64: z
      .string()
      .min(1)
      .max(32 * 1024 * 1024),
    indexProjection: conversationIndexProjectionSchema.optional(),
  })
  .strict();
export const conversationCheckpointParamsSchema = z
  .object({ sessionId: z.string().min(1) })
  .strict();
export type ConversationCheckpointResult = z.infer<typeof conversationCheckpointResultSchema>;
export interface ConversationSyncHost {
  readArtifact?(
    session: string,
    uri: string,
  ): Promise<import("./conversation-files.js").ConversationContentResult>;
  enumerate(): Promise<string[]>;
  capture(session: string): Promise<{ dataBase64: string; management: ConversationIndexFacts }>;
  captureContinuation?(
    session: string,
    operation: string,
  ): Promise<{ dataBase64: string; management: ConversationIndexFacts }>;
  continuationState?(
    session: string,
    operation: string,
  ): Promise<import("./conversation-runtime.js").ConversationRuntimeResult>;
  /** Trusted Host only. Rebuilds a missing projection, never imports or executes. */
  rebuildIndex?(input: {
    session: string;
    /** Exact surviving native text; for a tombstone use its nearest saved text ancestor. */
    dataBase64: string;
    management: ConversationIndexFacts;
    isCurrent(): boolean;
  }): Promise<void>;
}

export const conversationHistoryItemSchema = z
  .object({
    session: z.string().min(1),
    version: z.string().nullable(),
    title: z.string(),
    management: conversationIndexFactsSchema.nullable(),
    candidates: z.array(z.string()),
    selected: z.string().nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const conversationHistorySchema = z.array(conversationHistoryItemSchema);
export type ConversationHistoryItem = z.infer<typeof conversationHistoryItemSchema>;
export const conversationTranscriptSchema = z
  .object({
    session: z.string(),
    version: z.string(),
    title: z.string(),
    deleted: z.boolean(),
    messages: z.array(
      z.object({ id: z.string(), role: z.enum(["user", "assistant"]), text: z.string() }).strict(),
    ),
  })
  .strict();
export type ConversationTranscript = z.infer<typeof conversationTranscriptSchema>;
const choiceKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
export const conversationDeletionChoiceSchema = z
  .object({
    operation: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    session: choiceKey,
    version: choiceKey,
    candidates: z.array(choiceKey).min(1).max(10000),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ConversationDeletionChoice = z.infer<typeof conversationDeletionChoiceSchema>;
export const conversationDeletionReceiptSchema = z
  .object({
    operation: z.string().uuid(),
    session: choiceKey,
    version: choiceKey,
    revision: z.number().int().nonnegative(),
    outcome: z.literal("deleted"),
  })
  .strict();
export class ConversationChoiceError extends Error {
  constructor(readonly code: "stale" | "blocked" | "scope" | "unavailable") {
    super("Conversation choice: " + code);
  }
}
export interface ConversationHistoryReader {
  continuation?: {
    options(
      session: string,
      signal: AbortSignal,
    ): Promise<import("./conversation-continuation.js").ConversationContinuationOptions>;
    run(
      input: import("./conversation-continuation.js").ConversationContinuationIntent,
      signal: AbortSignal,
    ): Promise<import("./conversation-continuation.js").ConversationContinuationResult>;
    cancel(
      input: { session: string; operation: string },
      signal: AbortSignal,
    ): Promise<import("./conversation-continuation.js").ConversationContinuationResult>;
  };
  history(after: string | null, signal: AbortSignal): Promise<ConversationHistoryItem[]>;
  transcript(
    session: string,
    version: string,
    signal: AbortSignal,
  ): Promise<ConversationTranscript | null>;
  chooseDeletion?(input: ConversationDeletionChoice, signal: AbortSignal): Promise<void>;
}
export const conversationSyncStatusSchema = z
  .object({
    available: z.boolean(),
    error: z.enum(["limit", "scope", "transport"]).nullable(),
    pending: z.number().int().nonnegative().nullable(),
    scanning: z.boolean(),
    checkedAt: z.number().int().nonnegative().nullable(),
    blocked: z.array(z.object({ session: z.string(), code: z.string() }).strict()),
  })
  .strict();
export type ConversationSyncStatus = z.infer<typeof conversationSyncStatusSchema>;
