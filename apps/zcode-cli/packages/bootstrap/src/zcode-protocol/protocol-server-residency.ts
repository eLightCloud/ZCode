import type { ZCodeProtocolAgentServerMethodsContext } from "./protocol-server-context.js";
/** 低频 sampler 兜底入口；正常收敛由每个协议 request 的 operation lease 释放触发。 */

export function rebalanceResidentSessions(this: ZCodeProtocolAgentServerMethodsContext): void {
  this.context.sessionResidentPool?.rebalance();
}

/**
 * 借同一 60s 节拍做 event store 的时间兜底淘汰：
 * subagent 子 session 只有一个 turn，等不到下一个 turn_started，只能按时间清。返回淘汰条数。
 */

export function pruneSessionEventStores(
  this: ZCodeProtocolAgentServerMethodsContext,
  nowMs: number = Date.now(),
): number {
  let evicted = 0;
  for (const record of this.context.sessions.values()) {
    evicted += record.eventStore.pruneTransientEvents?.(nowMs) ?? 0;
  }
  return evicted;
}

/** 同一 60s 节拍：释放已终态、无订阅者、无 record 的 detached subagent child publisher。 */

export function pruneDetachedChildPublishers(
  this: ZCodeProtocolAgentServerMethodsContext,
  nowMs: number = Date.now(),
): number {
  return this.context.v4Gateway?.pruneDetachedChildPublishers(nowMs) ?? 0;
}

/**
 * 内存诊断计数器，随 60s 资源采样写本地日志。
 * 只读 Map.size / 数组长度，不触碰 session 状态；持久化 event store 不提供 getStats 时计 0。
 */

export function collectMemoryDiagnostics(
  this: ZCodeProtocolAgentServerMethodsContext,
): Record<string, number> {
  let eventRows = 0;
  let eventEvicted = 0;
  let eventTransientRetained = 0;
  for (const record of this.context.sessions.values()) {
    const stats = record.eventStore.getStats?.();
    eventRows += stats?.events ?? 0;
    eventEvicted += stats?.evictedEvents ?? 0;
    eventTransientRetained += stats?.retainedTransient ?? 0;
  }
  const counters: Record<string, number> = {
    sessions: this.context.sessions.size,
    eventRows,
    eventEvicted,
    eventTransientRetained,
  };
  const v4 = this.context.v4Gateway?.collectMemoryDiagnostics();
  if (v4) {
    for (const [key, value] of Object.entries(v4)) {
      counters[`v4.${key}`] = value;
    }
  }
  return counters;
}
