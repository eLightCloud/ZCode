import { type SessionEvent } from "@zcode/contracts";
import { type ZCodeSessionEvent } from "@zcode/shared";
import { type ZCodeProtocolAgentServerContext } from "./server-types.js";
import { measureJsonBytes, asRecord } from "./session-mapper-values.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
export function logProtocolSessionEventSent(
  context: ZCodeProtocolAgentServerContext,
  sourceEvent: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
): void {
  const payload =
    typeof mappedEvent.payload === "object" && mappedEvent.payload !== null
      ? (mappedEvent.payload as Record<string, unknown>)
      : {};
  const protocolMessage = {
    method: "session/event",
    params: mappedEvent,
  };
  context.logger?.debug("ZCode Protocol session event sent", {
    deliveryKind: mappedEvent.deliveryKind,
    event: "zcode_protocol.session_event.sent",
    eventId: mappedEvent.eventId,
    method: "session/event",
    module: "bootstrap.zcode_protocol",
    payloadKeys: Object.keys(payload).sort(),
    payloadKind: typeof payload.kind === "string" ? payload.kind : undefined,
    payloadSummary: summarizeProtocolPayload(payload),
    protocolMessageBytes: measureJsonBytes(protocolMessage),
    protocolPayloadBytes: measureJsonBytes(mappedEvent.payload),
    protocolEventType: mappedEvent.type,
    protocolSeq: mappedEvent.seq,
    sessionEventSequenceNumber: sourceEvent.sequenceNumber,
    sessionEventType: sourceEvent.type,
    sessionId: mappedEvent.sessionId,
    turnId: mappedEvent.turnId,
  });
}

function summarizeProtocolPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  copyStringFields(summary, payload, [
    "action",
    "anchorId",
    "assistantMessageId",
    "inputId",
    "kind",
    "queryId",
    "reason",
    "requestId",
    "resultPartId",
    "source",
    "status",
    "taskId",
    "terminalId",
    "toolCallId",
    "toolName",
  ]);
  copyBooleanFields(summary, payload, ["concurrentSafe", "destructive", "done", "readOnly"]);
  copyNumberFields(summary, payload, [
    "durationMs",
    "elapsedMs",
    "outputBytes",
    "stderrBytes",
    "stdoutBytes",
    "tokenCount",
    "toolCallCount",
  ]);
  copyByteLength(summary, payload, "content", "contentBytes");
  copyByteLength(summary, payload, "delta", "deltaBytes");
  copyByteLength(summary, payload, "input", "inputBytes");
  copyByteLength(summary, payload, "outputTail", "outputTailBytes");
  copyByteLength(summary, payload, "previousTarget", "previousTargetBytes");
  copyByteLength(summary, payload, "response", "responseBytes");
  copyByteLength(summary, payload, "result", "resultBytes");
  copyByteLength(summary, payload, "stderrTail", "stderrTailBytes");
  copyByteLength(summary, payload, "stdoutTail", "stdoutTailBytes");
  copyByteLength(summary, payload, "target", "targetBytes");
  copyObjectKeySummary(summary, payload, "input", "input");
  copyObjectKeySummary(summary, payload, "requestHeaders", "requestHeader");
  copyObjectKeySummary(summary, payload, "responseHeaders", "responseHeader");
  copyObjectKeySummary(summary, payload, "result", "result");
  copySmallObject(summary, payload, "usage");
  copyContextUsageBreakdownSummary(summary, payload);
  return summary;
}

function copyStringFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      target[key] = value;
    }
  }
}

function copyBooleanFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      target[key] = value;
    }
  }
}

function copyNumberFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] = value;
    }
  }
}

function copyByteLength(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  if (source[sourceKey] !== undefined) {
    target[targetKey] = measureJsonBytes(source[sourceKey]);
  }
}

function copyObjectKeySummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetPrefix: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const keys = Object.keys(value).sort();
  target[`${targetPrefix}KeyCount`] = keys.length;
  target[`${targetPrefix}Keys`] = keys.slice(0, 20);
}

function copySmallObject(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  if (measureJsonBytes(value) <= 1024) {
    target[sourceKey] = value;
  }
}

function copyContextUsageBreakdownSummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  const value = source.contextUsageBreakdown;
  if (!Array.isArray(value)) {
    return;
  }
  target.contextUsageBreakdownCount = value.length;
  target.contextUsageBreakdownSources = value
    .map((item) => asRecord(item).source)
    .filter((source): source is string => typeof source === "string")
    .slice(0, 20);
}
