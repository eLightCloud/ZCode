import type { CompactBoundaryPayload } from "./deps.js";
import type { CompactPhase } from "./deps.js";
import type { CompactReason } from "./deps.js";
import type { CompactTimelinePayload } from "./deps.js";
import type { CompactTimelineStatus } from "./deps.js";
import type { CompactTrigger } from "./deps.js";
import type { MessageId } from "./deps.js";
import type { MessageWithParts } from "./deps.js";
import type { Model } from "./deps.js";
import type { SessionEvent } from "./deps.js";
import type { TraceContext } from "./deps.js";
import type { CompactTimelineContext } from "./types.js";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type { AutoCompactLoopContext } from "./methods/turn-loop-state.js";
import type { AutoCompactOutcome } from "./methods/turn-loop-state.js";
import type { CompactAttemptOutcome } from "./methods/turn-loop-state.js";
import type { ReactiveCompactLoopContext } from "./methods/turn-loop-state.js";
import type { TurnRequestState } from "./methods/turn-loop-state.js";
import type { ModelToolContract } from "@zcode/contracts";

export interface InternalTurnCompactMethods {
  autoCompactIfNeeded(
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    abortSignal: AbortSignal | undefined,
    context: AutoCompactLoopContext,
  ): Promise<AutoCompactOutcome>;

  microcompactIfNeeded(
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    abortSignal: AbortSignal | undefined,
    context: {
      model: Model;
      modelStepIndex: number;
      phase: CompactPhase;
      turnRequestState: TurnRequestState;
    },
  ): Promise<void>;

  reactiveCompactAfterContextExceeded(
    originalError: unknown,
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    abortSignal: AbortSignal | undefined,
    context: ReactiveCompactLoopContext,
  ): Promise<CompactAttemptOutcome>;

  compactActiveConversation(
    customInstructions: string | undefined,
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    options?: {
      abortSignal?: AbortSignal;
      compactContextTelemetry?: {
        inputTokens: number;
        policyContextWindowTokens: number;
        thresholdTokens?: number;
        tokenSource: "estimate" | "provider_usage";
      };
      autoCompactThreshold?: number;
      compactReason?: CompactReason;
      initialPromptTooLongCause?: unknown;
      phase?: CompactPhase;
      sourceCommandId?: string;
      trigger?: CompactTrigger;
      model?: Model;
      agentListingTools?: readonly { name: string }[];
      activeEntries?: readonly RuntimeMessageEntry[];
      getContinuationTools?: () => readonly ModelToolContract[];
    },
  ): Promise<{
    displayText: string;
    entries: readonly RuntimeMessageEntry[];
    outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
    tokenCount: number;
  }>;

  buildCompactTimelinePayload(
    timeline: CompactTimelineContext,
    update: {
      attempt?: number;
      boundaryId?: string;
      endedAt?: number;
      maxAttempts?: number;
      postCompactTokenCount?: number;
      reason?: string;
      replace?: boolean;
      status: CompactTimelineStatus;
      summaryMessageId?: MessageId;
      tailStartMessageId?: MessageId;
      truePostCompactTokenCount?: number;
    },
  ): CompactTimelinePayload;

  persistCompactTimeline(
    payload: CompactTimelinePayload,
    traceContext: TraceContext,
  ): Promise<void>;

  finishCompactTimelineFailure(options: {
    abortSignal?: AbortSignal;
    attempt?: number;
    error: unknown;
    events: SessionEvent[];
    maxAttempts?: number;
    timeline: CompactTimelineContext;
    traceContext: TraceContext;
  }): Promise<void>;

  recoverInterruptedCompactTimelines(
    messages: MessageWithParts[],
    traceContext: TraceContext,
  ): Promise<number>;

  persistCompactSummary(
    messageID: MessageId,
    content: string,
    summary: string,
    compactBoundary: CompactBoundaryPayload,
    traceContext: TraceContext,
    options?: {
      model?: Model;
      operationId?: string;
      postCompactReminderEntries?: readonly RuntimeMessageEntry[];
    },
  ): Promise<void>;
}
