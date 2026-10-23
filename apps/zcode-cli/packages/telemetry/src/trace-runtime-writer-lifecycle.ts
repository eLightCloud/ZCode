/* oxlint-disable eslint(max-lines) -- concrete Writer 在同一文件显式维护各自 canonical key，避免运行时 Schema/Registry 再造一层映射。 */
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
