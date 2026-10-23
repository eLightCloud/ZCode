/* oxlint-disable eslint(max-lines) -- concrete Writer 在同一文件显式维护各自 canonical key，避免运行时 Schema/Registry 再造一层映射。 */
import { type Attributes, type Context, type Span } from "@opentelemetry/api";

import type {
  AgentStepSpanWriter,
  AgentTelemetryCancellationReason,
  AgentTelemetryErrorCategory,
  AgentTurnSpanWriter,
} from "@zcode/contracts/telemetry";

import { isAbortLike, type ActiveWriterContext, type WriterHealth } from "./agent-trace-support.js";

import { type AgentTelemetryMetricRecorder } from "./agent-metrics.js";

import { TrackedBaseWriter, classifyErrorCategory, lifecycleKeys } from "./trace-writer-base.js";

import type { TrackedWriter } from "./trace-writer-base.js";

export class TurnWriter extends TrackedBaseWriter implements AgentTurnSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("agent_turn"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  finishCompleted(
    resultType: "assistant_message" | "tool_request" | "no_output" | "other" = "other",
  ): void {
    this.finishCompletedIfOpen(() => this.setAttribute("zcode.agent_turn.result_type", resultType));
  }

  finishFailed(
    stage: "setup" | "agent_loop" | "finalize" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

export class StepWriter extends TrackedBaseWriter implements AgentStepSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("agent_step"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  finishCompleted(
    terminalReason:
      | "model_completed"
      | "tool_requested"
      | "turn_completed"
      | "compaction_requested",
  ): void {
    this.metricLabels.terminal_reason = terminalReason;
    this.finishCompletedIfOpen(() =>
      this.setAttribute("zcode.agent_step.terminal_reason", terminalReason),
    );
  }

  finishDiscarded(): void {
    this.finishDomainOutcomeIfOpen("discarded");
  }

  finishFailed(
    stage: "prepare" | "model" | "tool" | "commit" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}
