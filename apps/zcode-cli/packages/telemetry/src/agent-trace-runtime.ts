import type { AgentExecutionTelemetryRuntimeApi } from "./trace-runtime-api.js";
import type { AgentExecutionTelemetryRuntimeMethodsContext } from "./trace-runtime-context.js";
import { installAgentExecutionTelemetryRuntimeMethods } from "./trace-runtime-methods.js";
import type * as implementation2 from "./trace-runtime-model.js";
import type * as implementation1 from "./trace-runtime-operations.js";
import type * as implementation3 from "./trace-runtime-writer-lifecycle.js";

import { type Tracer } from "@opentelemetry/api";

import type {
  AgentExecutionTelemetryPort,
  ModelExecutionTelemetryPort,
  TelemetryIdentitySnapshot,
} from "@zcode/contracts/telemetry";

import { type WriterHealth } from "./agent-trace-support.js";

import {
  NOOP_AGENT_TELEMETRY_METRICS,
  type AgentMetricSpanName,
  type AgentTelemetryMetricRecorder,
} from "./agent-metrics.js";

import type { TrackedWriter } from "./trace-writer-base.js";

import { positiveLimit } from "./trace-metric-labels.js";

export { NoopAgentExecutionTelemetry } from "./trace-noop-writers.js";

export interface AgentTraceRuntimeOptions extends WriterHealth {
  identity?: TelemetryIdentitySnapshot;
  maxActiveWriters?: number;
  metrics?: AgentTelemetryMetricRecorder;
  tracer: Tracer;
}

export class AgentExecutionTelemetryRuntime
  implements AgentExecutionTelemetryPort, ModelExecutionTelemetryPort
{
  private readonly activeWriters: AgentExecutionTelemetryRuntimeMethodsContext["activeWriters"] = new Set<TrackedWriter>();
  private capacityWarningActive = false;
  private identity: AgentExecutionTelemetryRuntimeMethodsContext["identity"];
  private readonly maxActiveWriters: number;
  private readonly tracer: AgentExecutionTelemetryRuntimeMethodsContext["tracer"];
  private readonly health: AgentExecutionTelemetryRuntimeMethodsContext["health"];
  private readonly metrics: AgentExecutionTelemetryRuntimeMethodsContext["metrics"];

  constructor(options: AgentTraceRuntimeOptions) {
    this.tracer = options.tracer;
    this.maxActiveWriters = positiveLimit(options.maxActiveWriters, 5_000);
    this.health = { onWarning: options.onWarning };
    this.metrics = options.metrics ?? NOOP_AGENT_TELEMETRY_METRICS;
    this.identity = options.identity ?? { identityState: "unknown" };
  }

  declare private startCommand: OmitThisParameter<typeof implementation1.startCommand>;

  declare private startAttempt: OmitThisParameter<typeof implementation2.startAttempt>;

  declare private startSpan: OmitThisParameter<typeof implementation3.startSpan>;

  private track<T extends TrackedWriter>(writer: T): T {
    this.activeWriters.add(writer);
    return writer;
  }

  private safeCreate<T>(spanName: string, create: () => T, fallback: T): T {
    if (this.activeWriters.size >= this.maxActiveWriters) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "process_capacity"),
      );
      if (!this.capacityWarningActive) {
        this.capacityWarningActive = true;
        try {
          this.health.onWarning?.("Telemetry active writer capacity was reached", {
            activeWriterCount: this.activeWriters.size,
            maxActiveWriters: this.maxActiveWriters,
            spanName,
          });
        } catch {
          // 健康回调同样属于旁路。
        }
      }
      return fallback;
    }
    this.capacityWarningActive = false;
    try {
      return create();
    } catch (error) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "unknown"),
      );
      try {
        this.health.onWarning?.("Telemetry writer creation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
          spanName,
        });
      } catch {
        // 健康回调同样属于旁路。
      }
      return fallback;
    }
  }

  declare private safeMetric: OmitThisParameter<typeof implementation3.safeMetric>;
}

export interface AgentExecutionTelemetryRuntime extends AgentExecutionTelemetryRuntimeApi {}

installAgentExecutionTelemetryRuntimeMethods(AgentExecutionTelemetryRuntime.prototype);
