
import type {
  AgentStepSpanWriter,
  AgentTurnSpanWriter,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
  ModelCallSpanWriter,
  ToolExecutionSpanWriter,
} from "@zcode/contracts/telemetry";

import * as implementation2 from "./trace-runtime-model.js";
import * as implementation1 from "./trace-runtime-operations.js";
import * as implementation0 from "./trace-runtime-session.js";
export interface AgentExecutionTelemetryRuntimeApi {
  updateIdentity(...args: Parameters<typeof implementation0.updateIdentity>): void;
  captureCausation(
    ...args: Parameters<typeof implementation0.captureCausation>
  ): ReturnType<typeof implementation0.captureCausation>;
  startTurn(...args: Parameters<typeof implementation0.startTurn>): AgentTurnSpanWriter;
  startStep(...args: Parameters<typeof implementation0.startStep>): AgentStepSpanWriter;
  abandonSession(...args: Parameters<typeof implementation0.abandonSession>): void;
  abandonProcess(...args: Parameters<typeof implementation0.abandonProcess>): void;
  startTool(...args: Parameters<typeof implementation1.startTool>): ToolExecutionSpanWriter;
  startCompaction(
    ...args: Parameters<typeof implementation1.startCompaction>
  ): ContextCompactionSpanWriter;
  startDetachedOperation(
    ...args: Parameters<typeof implementation1.startDetachedOperation>
  ): DetachedOperationSpanWriter;
  startCall(...args: Parameters<typeof implementation2.startCall>): ModelCallSpanWriter;
}
