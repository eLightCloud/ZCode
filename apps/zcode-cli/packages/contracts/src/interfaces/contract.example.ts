import type { SessionEventStorePort, SessionEvent } from "./contract.js";

/** 重放只读追加 owner 分配后的序号，调用方不另造序列或接纳队列。 */
export async function appendAndReadExecutionFact(
  store: SessionEventStorePort,
  event: SessionEvent,
) {
  const accepted = await store.append(event);
  return store.getEventsAfter(accepted.sessionId, accepted.sequenceNumber - 1);
}
