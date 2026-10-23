/* oxlint-disable eslint(max-lines) -- concrete Writer 在同一文件显式维护各自 canonical key，避免运行时 Schema/Registry 再造一层映射。 */
import { ROOT_CONTEXT, context, trace } from "@opentelemetry/api";

import type {
  AgentStepSpanWriter,
  AgentStepTraceStart,
  AgentTelemetryExecutionContext,
  AgentTurnSpanWriter,
  AgentTurnTraceStart,
  TelemetryIdentitySnapshot,
} from "@zcode/contracts/telemetry";

import {
  activeWriterContext,
  compactAttributes,
  contextFromCausation,
  executionProjection,
  integer,
  safeEnum,
  safeId,
} from "./agent-trace-support.js";

import { causationLink, inheritedMetadata } from "./trace-writer-base.js";

import { stepMetricLabels, turnMetricLabels } from "./trace-metric-labels.js";

import { StepWriter, TurnWriter } from "./trace-turn-writers.js";

import { NOOP_STEP_WRITER, NOOP_TURN_WRITER } from "./trace-noop-writers.js";

import type { AgentExecutionTelemetryRuntimeMethodsContext } from "./trace-runtime-context.js";
export function updateIdentity(
  this: AgentExecutionTelemetryRuntimeMethodsContext,
  snapshot: TelemetryIdentitySnapshot,
): void {
  this.identity = {
    identityState: snapshot.identityState,
    ...(safeId(snapshot.userSubjectId) ? { userSubjectId: safeId(snapshot.userSubjectId) } : {}),
  };
}

export function captureCausation(this: AgentExecutionTelemetryRuntimeMethodsContext) {
  const active = activeWriterContext();
  if (!active) return undefined;
  const spanContext = active.span.spanContext();
  if (!trace.isSpanContextValid(spanContext)) return undefined;
  return {
    isRemote: spanContext.isRemote ?? false,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    traceId: spanContext.traceId,
    ...(spanContext.traceState ? { traceState: spanContext.traceState.serialize() } : {}),
    sessionId: active.correlation?.sessionId,
    turnId: active.correlation?.turnId,
    toolCallId: active.toolCallId,
  };
}

export function startTurn(
  this: AgentExecutionTelemetryRuntimeMethodsContext,
  input: AgentTurnTraceStart,
): AgentTurnSpanWriter {
  const correlation: AgentTelemetryExecutionContext = {
    ...input.context,
    identityState: this.identity.identityState,
    ...(this.identity.userSubjectId ? { userSubjectId: this.identity.userSubjectId } : {}),
  };
  const linkedRoot = input.causationMode !== "child";
  const links =
    input.causation && linkedRoot ? [causationLink(input.causation, "spawned_by")] : undefined;
  return this.safeCreate(
    "agent_turn",
    () => {
      const parentContext =
        input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
      const span = this.startSpan({
        attributes: compactAttributes({
          ...executionProjection(correlation, {
            includeActor: true,
            includeAgent: true,
            includeIdentity: true,
            includeQuery: true,
            includeSession: true,
          }),
          "zcode.agent_turn.turn_number": integer(input.turnNumber),
          "zcode.agent_turn.input_source": safeEnum(input.inputSource),
        }),
        context: parentContext,
        correlation,
        links,
        spanName: "agent_turn",
      });
      return this.track(
        new TurnWriter(
          span,
          parentContext,
          {
            correlation,
            spanName: "agent_turn",
          },
          this.health,
          this.metrics,
          turnMetricLabels(correlation, input.inputSource),
          (writer) => this.activeWriters.delete(writer),
        ),
      );
    },
    NOOP_TURN_WRITER,
  );
}

export function startStep(
  this: AgentExecutionTelemetryRuntimeMethodsContext,
  input: AgentStepTraceStart,
): AgentStepSpanWriter {
  const parent = activeWriterContext();
  return this.safeCreate(
    "agent_step",
    () => {
      const parentContext = parent?.activeContext ?? context.active();
      const span = this.startSpan({
        attributes: compactAttributes({
          ...executionProjection(parent?.correlation),
          "zcode.agent_step.step_id": safeId(input.stepId),
          "zcode.agent_step.step_index": integer(input.stepIndex),
        }),
        context: parentContext,
        correlation: parent?.correlation,
        parent,
        spanName: "agent_step",
        toolCallId: parent?.toolCallId,
      });
      return this.track(
        new StepWriter(
          span,
          parentContext,
          inheritedMetadata(parent, "agent_step"),
          this.health,
          this.metrics,
          stepMetricLabels(parent?.correlation),
          (writer) => this.activeWriters.delete(writer),
        ),
      );
    },
    NOOP_STEP_WRITER,
  );
}

export function abandonSession(
  this: AgentExecutionTelemetryRuntimeMethodsContext,
  sessionId: string,
): void {
  for (const writer of this.activeWriters) {
    if (writer.state.correlation?.sessionId === sessionId) {
      writer.abandon("session_shutdown");
    }
  }
}

export function abandonProcess(this: AgentExecutionTelemetryRuntimeMethodsContext): void {
  for (const writer of this.activeWriters) writer.abandon("process_shutdown");
}
