import { SpanKind, context, type Span } from "@opentelemetry/api";

import type { StartWriterOptions } from "./trace-writer-base.js";

import type { AgentExecutionTelemetryRuntimeMethodsContext } from "./trace-runtime-context.js";
export function startSpan(
  this: AgentExecutionTelemetryRuntimeMethodsContext,
  options: StartWriterOptions,
): Span {
  return this.tracer.startSpan(
    options.spanName,
    {
      attributes: options.attributes,
      kind: options.kind ?? SpanKind.INTERNAL,
      links: options.links,
    },
    options.context ?? context.active(),
  );
}

export function safeMetric(
  this: AgentExecutionTelemetryRuntimeMethodsContext,
  record: () => void,
): void {
  try {
    record();
  } catch (error) {
    try {
      this.health.onWarning?.("Telemetry metric operation failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    } catch {
      // Metric 与健康回调都属于旁路。
    }
  }
}
