import { conversationObservationReasonSchema } from "./conversation-diagnostics.js";
import { conversationTerminalMonitoringSchema } from "./conversation-terminals.js";
export { conversationObservationReasonSchema } from "./conversation-diagnostics.js";
import { z } from "zod";
import { conversationFileSchema } from "./conversation-files.js";
import { zcodeTaskMetaSchema } from "./validation.js";
/** Resource-reported references, never copied authorization or a global effects ledger. */
export const conversationEffectSchema = z
  .object({
    server: z.string().min(1).max(256),
    owner: z.string().min(1).max(256),
    operation: z.string().min(1).max(256),
    requestKey: z.string().min(1).max(256),
    receiptUri: z.string().regex(/^mcp-effect:\/\/[A-Za-z0-9_.:\/-]{1,900}$/),
    outcome: z.enum(["applied", "not_applied", "unknown"]),
  })
  .strict();
export type ConversationEffect = z.infer<typeof conversationEffectSchema>;
/** Native session IDs may become artifact directory segments after recovery. */
export const conversationSessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
  .refine((value) => value !== "." && value !== "..");

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
export type ConversationScope = z.infer<typeof conversationScopeSchema>;
export const conversationCenterPolicySchema = z
  .object({
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
    parentSessionId: conversationSessionIdSchema.optional(),
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
    cliFacts: z
      .object({
        titleSource: z.enum(["default", "generated", "custom"]),
        lastOutcome: z.enum(["completed", "interrupted", "error"]).optional(),
        deleted: z.boolean(),
      })
      .strict()
      .optional(),
    meta: zcodeTaskMetaSchema
      .pick({
        taskId: true,
        forkedFromTaskId: true,
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
export type ConversationIndexProjection = z.infer<typeof conversationIndexProjectionSchema>;

export const conversationCheckpointResultSchema = z
  .object({
    dataBase64: z
      .string()
      .min(1)
      .max(32 * 1024 * 1024),
    indexProjection: conversationIndexProjectionSchema.optional(),
    originCommandId: z.string().min(1).optional(),
  })
  .strict();
export const conversationCheckpointParamsSchema = z
  .object({ sessionId: z.string().min(1) })
  .strict();
export type ConversationCheckpointResult = z.infer<typeof conversationCheckpointResultSchema>;
export interface ConversationSyncHost {
  /** Explicit local legacy attribution only; caller binds the exact preview and current identity. */
  legacy?(
    session: string,
    attribute?: boolean,
    expected?: { dataBase64: string; management: ConversationIndexFacts },
  ): Promise<{ dataBase64: string; management: ConversationIndexFacts; originCommandId?: string }>;
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
    files: z.array(conversationFileSchema).optional(),
    effects: z.array(conversationEffectSchema).optional(),
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
  /** Display binding only; never grants resource or execution authority. */
  scope?(): string | null;
  continuation?: {
    /** Optional platform provisioning intent; never sends business input or restores a body. */
    prepareTarget?(session: string, signal: AbortSignal): Promise<void>;
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
  file?(
    session: string,
    version: string,
    uri: string,
    signal: AbortSignal,
  ): Promise<import("./conversation-files.js").ConversationContentResult>;
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
    sessions: z
      .array(
        z
          .object({
            session: z.string(),
            localVersion: z.string().nullable(),
            serverVersion: z.string().nullable(),
            selected: z.string().nullable(),
            candidates: z.array(z.string()),
            location: z.string().nullable(),
            pending: z.number().int().nonnegative(),
            blocked: z.string().nullable(),
          })
          .strict(),
      )
      .optional(),
    blocked: z.array(z.object({ session: z.string(), code: z.string() }).strict()),
  })
  .strict();
export type ConversationSyncStatus = z.infer<typeof conversationSyncStatusSchema>;

/** Native administration: aggregate metadata only, never conversation identifiers or content. */
export const conversationObservationSchema = z
  .object({
    action: z.enum(["checkpoint", "file_upload", "file_read", "continuation"]),
    outcome: z.enum(["succeeded", "rejected", "failed", "waiting"]),
    reason: conversationObservationReasonSchema,
  })
  .strict();
export type ConversationObservation = z.infer<typeof conversationObservationSchema>;
const monitoringCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const monitoringTime = z.string().datetime({ offset: true });
export const conversationMonitoringSchema = z
  .object({
    observedAt: monitoringTime,
    startedAt: monitoringTime,
    windowStartedAt: monitoringTime,
    configuration: conversationCenterConfigurationSchema,
    collectionAvailable: z.boolean(),
    processStartedAt: monitoringTime.nullable(),
    unrecordedRequests: monitoringCount,
    lastPersistFailureAt: monitoringTime.nullable(),
    capacity: z
      .object({
        sessions: monitoringCount,
        versions: monitoringCount,
        subjects: monitoringCount,
        checkpointBytes: monitoringCount,
        fileBytes: monitoringCount,
        files: monitoringCount,
        largestSubjectBytes: monitoringCount,
        subjectsAtCapacity: monitoringCount,
        largestCheckpointBytes: monitoringCount,
        largestSessionVersions: monitoringCount,
        sessionsAtVersionLimit: monitoringCount,
        unfinishedContinuations: monitoringCount,
      })
      .strict(),
    terminals: conversationTerminalMonitoringSchema,
    requests: z
      .array(
        conversationObservationSchema.extend({
          count: monitoringCount,
          lastObservedAt: monitoringTime,
        }),
      )
      .max(256),
  })
  .strict();
export type ConversationMonitoring = z.infer<typeof conversationMonitoringSchema>;

export type {
  ConversationTerminalReason,
  ConversationTerminalMonitoring,
} from "./conversation-terminals.js";

/** Configuration-only metadata projection; selectors confer no data-plane authority. */
export const conversationUsageQuerySchema = z
  .object({
    tenant: z.string().uuid().optional(),
    subject: z.string().uuid().optional(),
    excludeTenant: z.string().uuid().optional(),
    offset: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine((value) => !value.subject || !!value.tenant);
export type ConversationUsageQuery = z.infer<typeof conversationUsageQuerySchema>;
export const conversationUsagePageSchema = z
  .object({
    observedAt: monitoringTime,
    total: monitoringCount,
    totalBytes: monitoringCount,
    items: z
      .array(
        z
          .object({
            key: z.string().uuid(),
            bytes: monitoringCount,
            checkpointBytes: monitoringCount,
            fileBytes: monitoringCount,
            subjects: monitoringCount,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
