import type { Span, Tracer } from "@opentelemetry/api";
import type {
  CommandExecutionSpanWriter,
  CommandTraceStart,
  ModelAttemptSpanWriter,
  ModelAttemptTraceStart,
  TelemetryIdentitySnapshot,
} from "@zcode/contracts/telemetry";
import type { AgentTelemetryMetricRecorder } from "./agent-metrics.js";
import type { WriterHealth } from "./agent-trace-support.js";
import type { ModelCallWriter } from "./trace-model-writers.js";
import type { ToolWriter } from "./trace-operation-writers.js";
import type { StartWriterOptions, TrackedWriter } from "./trace-writer-base.js";

/**
 * 同一 telemetry owner 的内部写入视图。类型只依赖 span 合同与 writer，不能反向索引
 * owner 类的私有字段；否则 owner → 方法 → context → owner 形成循环，变更无法独立核验。
 * 本视图不创建第二份状态，不作为包公开端口。
 */
export interface AgentExecutionTelemetryRuntimeMethodsContext {
  readonly activeWriters: Set<TrackedWriter>;
  identity: TelemetryIdentitySnapshot;
  readonly tracer: Tracer;
  readonly health: WriterHealth;
  readonly metrics: AgentTelemetryMetricRecorder;
  startCommand(input: CommandTraceStart & { parent: ToolWriter }): CommandExecutionSpanWriter;
  startAttempt(parentWriter: ModelCallWriter, input: ModelAttemptTraceStart): ModelAttemptSpanWriter;
  startSpan(options: StartWriterOptions): Span;
  track<T extends TrackedWriter>(writer: T): T;
  safeCreate<T>(spanName: string, create: () => T, fallback: T): T;
}
