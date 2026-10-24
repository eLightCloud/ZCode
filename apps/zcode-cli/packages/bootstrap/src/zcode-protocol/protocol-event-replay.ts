import { type SessionEvent, type SessionId } from "@zcode/contracts";
import { type ZCodeDeliveryKind, type ZCodeSessionEvent } from "@zcode/shared";
import { shouldExposeSessionEventToProtocol } from "./mapper.js";
import {
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
  type ZCodeProtocolToolInputTransmissionState,
} from "./server-types.js";
import {
  type ProtocolStreamingDeltaBatch,
  rememberProtocolStreamingDeltaBatchFlush,
  materializeProtocolStreamingDeltaBatch,
  readStreamingDeltaBatchableEvent,
  mergeProtocolStreamingDeltaBatch,
  shouldFlushProtocolStreamingDeltaBatchForInterval,
} from "./protocol-streaming-batch.js";
import {
  mapProtocolSessionEvent,
  shouldHideProtocolSessionEvent,
  getProtocolEventSequenceState,
} from "./protocol-event-sequence.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
export async function readProtocolSessionEvents(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<ZCodeSessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  const visibleEvents: ZCodeSessionEvent[] = [];
  const toolInputTransmissions: ZCodeProtocolToolInputTransmissionState = {
    streamedToolCallIdsWithInput: new Set(),
  };
  let pendingStreamingDeltaBatch: ProtocolStreamingDeltaBatch | undefined;
  const flushedFirstDeltaBatchKeys = new Set<string>();
  const lastFlushAtByBatchKey = new Map<string, number>();
  const pushMappedEvent = (event: SessionEvent): void => {
    const mappedEvent = mapProtocolSessionEvent(context, record, event, deliveryKind, {
      toolInputTransmissions,
    });
    if (!mappedEvent) return;
    if (options.afterSeq !== undefined && mappedEvent.seq <= options.afterSeq) return;
    visibleEvents.push(mappedEvent);
  };
  const flushPendingStreamingDeltaBatch = (): void => {
    if (!pendingStreamingDeltaBatch) {
      return;
    }
    rememberProtocolStreamingDeltaBatchFlush(lastFlushAtByBatchKey, pendingStreamingDeltaBatch);
    pushMappedEvent(materializeProtocolStreamingDeltaBatch(pendingStreamingDeltaBatch));
    pendingStreamingDeltaBatch = undefined;
  };
  const resetPendingStreamingDeltaBatch = (): void => {
    flushPendingStreamingDeltaBatch();
    flushedFirstDeltaBatchKeys.clear();
    lastFlushAtByBatchKey.clear();
  };
  for (const event of events) {
    if (
      shouldHideProtocolSessionEvent(record, event) ||
      !shouldExposeSessionEventToProtocol(event)
    ) {
      resetPendingStreamingDeltaBatch();
      pushMappedEvent(event);
      continue;
    }
    const deltaInfo = readStreamingDeltaBatchableEvent(event);
    if (deltaInfo) {
      if (
        pendingStreamingDeltaBatch &&
        pendingStreamingDeltaBatch.batchKey !== deltaInfo.batchKey
      ) {
        flushPendingStreamingDeltaBatch();
      }
      pendingStreamingDeltaBatch = mergeProtocolStreamingDeltaBatch(
        pendingStreamingDeltaBatch,
        event,
        deltaInfo,
      );
      if (deltaInfo.shouldFlushFirstDelta && !flushedFirstDeltaBatchKeys.has(deltaInfo.batchKey)) {
        flushPendingStreamingDeltaBatch();
        flushedFirstDeltaBatchKeys.add(deltaInfo.batchKey);
        continue;
      }
      if (
        pendingStreamingDeltaBatch.delta.length >= pendingStreamingDeltaBatch.maxChars ||
        shouldFlushProtocolStreamingDeltaBatchForInterval(
          pendingStreamingDeltaBatch,
          lastFlushAtByBatchKey,
        )
      ) {
        flushPendingStreamingDeltaBatch();
      }
      continue;
    }
    resetPendingStreamingDeltaBatch();
    pushMappedEvent(event);
  }
  flushPendingStreamingDeltaBatch();
  return options.limit ? visibleEvents.slice(-options.limit) : visibleEvents;
}

export async function getProtocolEventSeq(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): Promise<number> {
  await readProtocolSessionEvents(context, record, deliveryKind);
  return getProtocolEventSequenceState(record, deliveryKind).lastSeq;
}
