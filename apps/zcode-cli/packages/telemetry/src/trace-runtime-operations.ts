import { ROOT_CONTEXT, context } from "@opentelemetry/api";

import type {
  CommandExecutionSpanWriter,
  CommandTraceStart,
  CompactionTraceStart,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
  DetachedOperationTraceStart,
  ToolExecutionSpanWriter,
  ToolTraceStart,
} from "@zcode/contracts/telemetry";

import {
  activeWriterContext,
  compactAttributes,
  contextFromCausation,
  executionProjection,
  finiteNonNegative,
  integer,
  safeEnum,
  safeId,
  safeString,
} from "./agent-trace-support.js";

import { toolCompatibilityAttributes } from "./compatibility-adapters.js";

import { causationLink, inheritedMetadata } from "./trace-writer-base.js";

import {
  commandMetricLabels,
  compactionMetricLabels,
  detachedMetricLabels,
  toolMetricLabels,
} from "./trace-metric-labels.js";

import {
  NOOP_COMMAND_WRITER,
  NOOP_COMPACTION_WRITER,
  NOOP_DETACHED_WRITER,
  NOOP_TOOL_WRITER,
} from "./trace-noop-writers.js";

import { CommandWriter, ToolWriter } from "./trace-operation-writers.js";

import { CompactionWriter, DetachedWriter } from "./trace-maintenance-writers.js";

import type { AgentExecutionTelemetryRuntimeMethodsContext } from "./trace-runtime-context.js";
export function startTool(
  this: AgentExecutionTelemetryRuntimeMethodsContext,
  input: ToolTraceStart,
): ToolExecutionSpanWriter {
  const parent = activeWriterContext();
  return this.safeCreate(
    "tool_execution",
    () => {
      const parentContext = parent?.activeContext ?? context.active();
      const toolName = safeString(input.registeredToolName, 128);
      const span = this.startSpan({
        attributes: compactAttributes({
          ...executionProjection(parent?.correlation, { includeActor: true }),
          "zcode.execution.tool_call_id": safeId(input.toolCallId),
          "zcode.tool_execution.tool_name": toolName,
          ...toolCompatibilityAttributes({
            toolCallId: input.toolCallId,
            toolName: input.registeredToolName,
          }),
        }),
        context: parentContext,
        correlation: parent?.correlation,
        parent,
        spanName: "tool_execution",
        toolCallId: safeId(input.toolCallId),
      });
      return this.track(
        new ToolWriter(
          span,
          parentContext,
          {
            ...inheritedMetadata(parent, "tool_execution"),
            toolCallId: safeId(input.toolCallId),
          },
          this.health,
          this.metrics,
          toolMetricLabels(input.registeredToolName),
          (writer) => this.activeWriters.delete(writer),
          (command) => this.startCommand(command),
        ),
      );
    },
    NOOP_TOOL_WRITER,
  );
}

export function startCompaction(
  this: AgentExecutionTelemetryRuntimeMethodsContext,
  input: CompactionTraceStart,
): ContextCompactionSpanWriter {
  const parent = activeWriterContext();
  return this.safeCreate(
    "context_compaction",
    () => {
      const parentContext = parent?.activeContext ?? context.active();
      const span = this.startSpan({
        attributes: compactAttributes({
          ...executionProjection(parent?.correlation),
          "zcode.context_compaction.trigger": safeEnum(input.trigger),
          "zcode.context_compaction.phase": safeEnum(input.phase),
          "zcode.context_compaction.model_mode": safeEnum(input.modelMode),
          "zcode.context_compaction.outer_attempt": integer(input.outerAttempt),
          "zcode.context_compaction.max_attempts": integer(input.maxAttempts),
          "zcode.context_compaction.triggering_step_index": integer(input.triggeringStepIndex),
          "zcode.context_compaction.policy_context_window_tokens": finiteNonNegative(
            input.policyContextWindowTokens,
          ),
          "zcode.context_compaction.threshold_tokens": finiteNonNegative(input.thresholdTokens),
          "zcode.context_compaction.token_source": safeEnum(input.tokenSource),
          "zcode.context_compaction.recovered_from_logical_call_id": safeId(
            input.recoveredFromLogicalCallId,
          ),
        }),
        context: parentContext,
        correlation: parent?.correlation,
        parent,
        spanName: "context_compaction",
        toolCallId: parent?.toolCallId,
      });
      return this.track(
        new CompactionWriter(
          span,
          parentContext,
          inheritedMetadata(parent, "context_compaction"),
          this.health,
          this.metrics,
          compactionMetricLabels(input),
          (writer) => this.activeWriters.delete(writer),
        ),
      );
    },
    NOOP_COMPACTION_WRITER,
  );
}

export function startDetachedOperation(
  this: AgentExecutionTelemetryRuntimeMethodsContext,
  input: DetachedOperationTraceStart,
): DetachedOperationSpanWriter {
  const linkedRoot = input.executionKind !== "foreground";
  const links =
    input.causation && linkedRoot
      ? [
          causationLink(
            input.causation,
            input.trigger === "recovery" ? "resumed_from" : "triggered_by",
          ),
        ]
      : undefined;
  return this.safeCreate(
    "detached_operation",
    () => {
      const parentContext =
        input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
      const span = this.startSpan({
        attributes: compactAttributes({
          ...executionProjection(input.context, {
            includeActor: true,
            includeQuery: true,
            includeSession: true,
          }),
          "zcode.detached_operation.operation": safeEnum(input.operation),
          "zcode.detached_operation.execution_kind": safeEnum(input.executionKind),
          "zcode.detached_operation.trigger": safeEnum(input.trigger),
          "zcode.detached_operation.target_kind": safeEnum(input.targetKind),
          "zcode.detached_operation.goal_iteration": integer(input.goalIteration),
          "zcode.detached_operation.chunk_index": integer(input.chunkIndex),
          "zcode.detached_operation.chunk_count": integer(input.chunkCount),
        }),
        context: parentContext,
        correlation: input.context,
        links,
        spanName: "detached_operation",
      });
      return this.track(
        new DetachedWriter(
          span,
          parentContext,
          {
            correlation: input.context,
            spanName: "detached_operation",
          },
          this.health,
          this.metrics,
          detachedMetricLabels(input),
          (writer) => this.activeWriters.delete(writer),
        ),
      );
    },
    NOOP_DETACHED_WRITER,
  );
}

export function startCommand(
  this: AgentExecutionTelemetryRuntimeMethodsContext,
  input: CommandTraceStart & { parent: ToolWriter },
): CommandExecutionSpanWriter {
  const parent = input.parent.state;
  return this.safeCreate(
    "command_execution",
    () => {
      const span = this.startSpan({
        attributes: compactAttributes({
          ...executionProjection(parent.correlation),
          "zcode.execution.tool_call_id": safeId(parent.toolCallId),
          "zcode.command_execution.safe_name": safeString(input.safeName, 128),
          "zcode.command_execution.category": safeEnum(input.category),
          "zcode.command_execution.command_count": integer(input.commandCount),
          "zcode.command_execution.shell_kind": safeEnum(input.shellKind),
          "zcode.command_execution.sandboxed": input.sandboxed,
        }),
        context: parent.activeContext,
        correlation: parent.correlation,
        parent,
        spanName: "command_execution",
        toolCallId: parent.toolCallId,
      });
      return this.track(
        new CommandWriter(
          span,
          parent.activeContext,
          inheritedMetadata(parent, "command_execution"),
          this.health,
          this.metrics,
          commandMetricLabels(input),
          (writer) => this.activeWriters.delete(writer),
        ),
      );
    },
    NOOP_COMMAND_WRITER,
  );
}
