import { type SessionEvent, SessionEventType } from "@zcode/contracts";
import { type ZCodeDeliveryKind, type ZCodeSessionEvent } from "@zcode/shared";
import { mapSessionEventForProtocol, shouldExposeSessionEventToProtocol } from "./mapper.js";
import {
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
  type ZCodeProtocolToolInputTransmissionState,
} from "./server-types.js";
import { asRecord, stringValue, measureJsonBytes } from "./session-mapper-values.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
const DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY = "__default__";

export function protocolEventSequenceKey(deliveryKind?: ZCodeDeliveryKind): string {
  return deliveryKind ?? DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY;
}

export function getProtocolEventSequenceState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
) {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolEventSequences.get(key);
  if (existing) {
    return existing;
  }
  const created = {
    lastSeq: 0,
    seqBySourceEventKey: new Map<string, number>(),
  };
  record.protocolEventSequences.set(key, created);
  return created;
}

function getProtocolToolInputTransmissionState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): ZCodeProtocolToolInputTransmissionState {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolToolInputTransmissions.get(key);
  if (existing) {
    return existing;
  }
  const created: ZCodeProtocolToolInputTransmissionState = {
    streamedToolCallIdsWithInput: new Set(),
  };
  record.protocolToolInputTransmissions.set(key, created);
  return created;
}

function protocolSourceEventKey(event: SessionEvent): string {
  return event.sequenceNumber > 0 ? `seq:${event.sequenceNumber}` : `event:${String(event.id)}`;
}

function assignProtocolEventSeq(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
): number {
  const state = getProtocolEventSequenceState(record, deliveryKind);
  const sourceEventKey = protocolSourceEventKey(event);
  const existing = state.seqBySourceEventKey.get(sourceEventKey);
  if (existing !== undefined) {
    return existing;
  }
  const nextSeq = state.lastSeq + 1;
  state.lastSeq = nextSeq;
  state.seqBySourceEventKey.set(sourceEventKey, nextSeq);
  return nextSeq;
}

function markStreamedToolInputIfPresent(
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): void {
  if (mappedEvent.type !== "model.streaming") {
    return;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "tool_call" || !("input" in payload)) {
    return;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) {
    return;
  }
  toolInputTransmissions.streamedToolCallIdsWithInput.add(toolCallId);
}

function omitDuplicateScheduledToolInput(
  event: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): ZCodeSessionEvent {
  markStreamedToolInputIfPresent(mappedEvent, toolInputTransmissions);
  if (event.type !== SessionEventType.ToolCallScheduled || mappedEvent.type !== "tool.updated") {
    return mappedEvent;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "scheduled" || !("input" in payload)) {
    return mappedEvent;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId || !toolInputTransmissions.streamedToolCallIdsWithInput.has(toolCallId)) {
    return mappedEvent;
  }

  const nextPayload: Record<string, unknown> = { ...payload };
  const input = nextPayload.input;
  delete nextPayload.input;
  nextPayload.inputByteLength = measureJsonBytes(input);
  nextPayload.inputOmitted = true;
  nextPayload.inputRef = "model_stream";
  // 性能修复：AI SDK 的 tool_call 已经在 model.streaming 里交付完整 input；
  // scheduled 只是生命周期边界，重复携带 Write/Edit 大参数会让 stdio 和 renderer 双重放大。
  return {
    ...mappedEvent,
    payload: nextPayload,
  };
}

export function shouldHideProtocolSessionEvent(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): boolean {
  const payload = asRecord(event.payload);
  const querySource = stringValue(payload.querySource);
  if (event.type === "model_request" && querySource === "session_title") {
    return true;
  }
  if (event.type === "model_network_status" && querySource === "session_title") {
    // 不能用标题生成的全局 suppress 标记隐藏 model_network_status：
    // 标题请求重试时会把并发主请求的 retry 事件也吞掉，导致 app 输入框右下角看不到重试次数。
    // status 事件带 querySource，只隐藏标题生成自己的网络状态。
    return true;
  }
  if (event.type === "model_complete" && querySource === "session_title") {
    return true;
  }
  return false;
}

export function mapProtocolSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: {
    toolInputTransmissions?: ZCodeProtocolToolInputTransmissionState;
  } = {},
): ZCodeSessionEvent | null {
  if (shouldHideProtocolSessionEvent(record, event)) {
    return null;
  }
  if (!shouldExposeSessionEventToProtocol(event)) {
    const payload = asRecord(event.payload);
    context.logger?.debug("ZCode Protocol session event filtered", {
      event: "zcode_protocol.session_event.filtered",
      eventId: String(event.id),
      module: "bootstrap.zcode_protocol",
      payloadKind: stringValue(payload.kind),
      sessionEventSequenceNumber: event.sequenceNumber,
      sessionEventType: event.type,
      sessionId: String(event.sessionId),
      turnId: event.turnId ? String(event.turnId) : undefined,
    });
    return null;
  }
  // eventStore 的 sequenceNumber 是内部全量账本，包含被协议过滤的
  // tool_input_delta 等高频模型中间态。ZCode Protocol 的 seq 是 UI/replay 的恢复键，
  // 必须按“协议实际可见事件流”重新连续编号，不能直接暴露内部 sequenceNumber。
  // sequenceNumber=0 的 subagent mirror/live-only 事件没有进入父 eventStore，也必须
  // 按 eventId 分配独立 seq，不能全部复用同一个 0 号映射。
  const protocolSeq = assignProtocolEventSeq(record, event, deliveryKind);
  const mappedEvent = mapSessionEventForProtocol(event, deliveryKind, {
    seq: protocolSeq,
  });
  if (!mappedEvent) {
    return null;
  }
  return omitDuplicateScheduledToolInput(
    event,
    mappedEvent,
    options.toolInputTransmissions ?? getProtocolToolInputTransmissionState(record, deliveryKind),
  );
}
