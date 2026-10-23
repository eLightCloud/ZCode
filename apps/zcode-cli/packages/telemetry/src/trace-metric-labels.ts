import { type Attributes } from "@opentelemetry/api";

import type {
  AgentTelemetryExecutionContext,
  AgentTurnTraceStart,
  CommandTraceStart,
  CompactionTraceStart,
  DetachedOperationTraceStart,
  ModelCallTraceStart,
} from "@zcode/contracts/telemetry";

import {
  compactAttributes,
  safeEnum,
  safeString,
  type WriterTerminalObservation,
} from "./agent-trace-support.js";

export function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

export function terminalMetricLabels(
  labels: Attributes,
  observation: WriterTerminalObservation,
): Attributes {
  return compactAttributes({
    ...labels,
    error_category: observation.errorCategory,
  });
}

export function turnMetricLabels(
  correlation: AgentTelemetryExecutionContext,
  inputSource: AgentTurnTraceStart["inputSource"],
): Attributes {
  return compactAttributes({
    actor_kind: safeEnum(correlation.actorKind),
    input_source: safeEnum(inputSource),
    launch_surface: safeEnum(correlation.launchSurface),
  });
}

export function stepMetricLabels(
  correlation: AgentTelemetryExecutionContext | undefined,
): Attributes {
  return compactAttributes({
    actor_kind: safeEnum(correlation?.actorKind),
  });
}

export function toolMetricLabels(toolName: string): Attributes {
  return {
    tool_name: safeString(toolName, 128),
  };
}

export function commandMetricLabels(input: CommandTraceStart): Attributes {
  return compactAttributes({
    command_category: safeEnum(input.category),
    command_safe_name: safeString(input.safeName, 128),
  });
}

export function compactionMetricLabels(input: CompactionTraceStart): Attributes {
  return compactAttributes({
    model_mode: safeEnum(input.modelMode),
    trigger: safeEnum(input.trigger),
  });
}

export function detachedMetricLabels(input: DetachedOperationTraceStart): Attributes {
  return compactAttributes({
    execution_kind: safeEnum(input.executionKind),
    operation: safeEnum(input.operation),
  });
}

export function modelCallMetricLabels(input: ModelCallTraceStart): Attributes {
  return compactAttributes({
    call_cause: safeEnum(input.callCause ?? "initial"),
    model_operation: safeEnum(input.operation),
    model_role: safeEnum(input.modelRole),
  });
}
