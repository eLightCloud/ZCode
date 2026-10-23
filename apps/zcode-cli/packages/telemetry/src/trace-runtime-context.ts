import type { AgentExecutionTelemetryRuntime } from "./agent-trace-runtime.js";

/** 同一 owner 的内部类型视图；不复制状态，不暴露到端口。 */
export interface AgentExecutionTelemetryRuntimeMethodsContext {
  readonly activeWriters: AgentExecutionTelemetryRuntime["activeWriters"];
  capacityWarningActive: AgentExecutionTelemetryRuntime["capacityWarningActive"];
  identity: AgentExecutionTelemetryRuntime["identity"];
  readonly maxActiveWriters: AgentExecutionTelemetryRuntime["maxActiveWriters"];
  readonly tracer: AgentExecutionTelemetryRuntime["tracer"];
  readonly health: AgentExecutionTelemetryRuntime["health"];
  readonly metrics: AgentExecutionTelemetryRuntime["metrics"];
  updateIdentity: AgentExecutionTelemetryRuntime["updateIdentity"];
  captureCausation: AgentExecutionTelemetryRuntime["captureCausation"];
  startTurn: AgentExecutionTelemetryRuntime["startTurn"];
  startStep: AgentExecutionTelemetryRuntime["startStep"];
  startTool: AgentExecutionTelemetryRuntime["startTool"];
  startCompaction: AgentExecutionTelemetryRuntime["startCompaction"];
  startDetachedOperation: AgentExecutionTelemetryRuntime["startDetachedOperation"];
  startCall: AgentExecutionTelemetryRuntime["startCall"];
  abandonSession: AgentExecutionTelemetryRuntime["abandonSession"];
  abandonProcess: AgentExecutionTelemetryRuntime["abandonProcess"];
  startCommand: AgentExecutionTelemetryRuntime["startCommand"];
  startAttempt: AgentExecutionTelemetryRuntime["startAttempt"];
  startSpan: AgentExecutionTelemetryRuntime["startSpan"];
  track: AgentExecutionTelemetryRuntime["track"];
  safeCreate: AgentExecutionTelemetryRuntime["safeCreate"];
  safeMetric: AgentExecutionTelemetryRuntime["safeMetric"];
}
