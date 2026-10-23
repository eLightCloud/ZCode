// ============================================================
// Read Tool Handler
// ============================================================

import type { ToolExecutionContext } from "../types.js";

import { type TraceContext } from "@zcode/contracts";

export function createReadTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}
