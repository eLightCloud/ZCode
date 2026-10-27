import { z } from "zod";
import { conversationObservationReasonSchema } from "./conversation-diagnostics.js";

/** Protocol observation validity, not execution liveness or an administrator quota. */
export const CONVERSATION_TERMINAL_FRESHNESS_MS = 120_000;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.string().datetime({ offset: true });
export const conversationTerminalReasonSchema = z.enum([
  ...conversationObservationReasonSchema.options,
  "limit",
  "transport",
  "capture",
  "unsupported",
  "owner_unknown",
  "index",
  "identity_unavailable",
]);
export type ConversationTerminalReason = z.infer<typeof conversationTerminalReasonSchema>;
export const conversationTerminalRuntimeSchema = z
  .object({
    phase: z.enum(["scanning", "syncing", "waiting_retry", "blocked", "caught_up"]),
    error: conversationTerminalReasonSchema.nullable(),
    consecutiveFailures: count,
    nextAttemptAt: time.nullable(),
    localReasons: z
      .array(z.object({ reason: conversationTerminalReasonSchema, sessions: count }).strict())
      .max(48),
  })
  .strict();
export type ConversationTerminalRuntime = z.infer<typeof conversationTerminalRuntimeSchema>;
export const conversationTerminalReportSchema = conversationTerminalRuntimeSchema
  .extend({
    sequence: count.positive(),
    observedAt: time,
    queue: z
      .object({
        items: count,
        sessions: count,
        checkpointBytes: count,
        fileBytes: count,
        oldestPendingAt: time.nullable(),
        unknownAgeItems: count,
        attemptedItems: count,
        attempts: count,
        lastAttemptAt: time.nullable(),
        lastAcknowledgedAt: time.nullable(),
        acknowledgedItems: count,
      })
      .strict(),
    reasons: z
      .array(
        z
          .object({ reason: conversationTerminalReasonSchema, sessions: count, items: count })
          .strict(),
      )
      .max(48),
    recovery: z
      .object({
        lastCaughtUpAt: time.nullable(),
        lastRecoveredItems: count,
        lastPendingPeak: count,
        pendingPeak: count,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.queue.sessions > value.queue.items ||
      value.queue.attemptedItems > value.queue.items ||
      value.queue.unknownAgeItems > value.queue.items ||
      (value.phase === "caught_up" &&
        (value.queue.items > 0 || value.localReasons.length > 0 || value.error !== null))
    )
      context.addIssue({ code: "custom", message: "Inconsistent terminal observation" });
  });
export type ConversationTerminalReport = z.infer<typeof conversationTerminalReportSchema>;
export const conversationTerminalAcknowledgementSchema = z
  .object({
    accepted: z.boolean(),
    sequence: count.positive(),
    sourceRef: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const conversationTerminalMonitoringSchema = z
  .object({
    freshnessMs: count.positive(),
    knownSources: count,
    freshSources: count,
    staleSources: count,
    freshPendingItems: count,
    stalePendingItems: count,
    freshPendingBytes: count,
    freshBlockedSources: count,
    freshRetryingSources: count,
    freshCaughtUpSources: count,
    latestCaughtUpAt: time.nullable(),
    sources: z
      .array(
        z
          .object({
            sourceRef: z.string().regex(/^[a-f0-9]{64}$/),
            kind: z.enum(["desktop", "server"]),
            receivedAt: time,
            fresh: z.boolean(),
            report: conversationTerminalReportSchema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type ConversationTerminalMonitoring = z.infer<typeof conversationTerminalMonitoringSchema>;
