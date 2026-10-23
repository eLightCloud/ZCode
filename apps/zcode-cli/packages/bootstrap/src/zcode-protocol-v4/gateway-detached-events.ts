// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。
import type { SessionEvent } from "@zcode/contracts";

import { SessionEventType } from "@zcode/contracts";

import { DETACHED_CHILD_PUBLISHER_GRACE_MS } from "./gateway-support.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
/**
 * subagent child 使用父 record 的外部 sink，但保留独立 session topic。显式登记这类
 * detached live session，避免把任意偶然存在的 cold publisher 都误判为运行中 child。
 */

export function ingestDetachedLiveSession(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  event: SessionEvent,
  parentSessionId?: string,
): void {
  if (!this.detachedLiveSessions.has(sessionId)) {
    this.host.onDebug?.(`register detached live child publisher session=${sessionId}`);
  }
  this.detachedLiveSessions.add(sessionId);
  if (parentSessionId && parentSessionId !== sessionId) {
    this.detachedChildParent.set(sessionId, parentSessionId);
    let children = this.detachedChildrenByParent.get(parentSessionId);
    if (!children) {
      children = new Set();
      this.detachedChildrenByParent.set(parentSessionId, children);
    }
    children.add(sessionId);
  }
  // child 是一次性 session，没有 record 也没有后继 turn，publisher 曾驻留到进程退出。
  // 记下终态时间，供 pruneDetachedChildPublishers 在 grace 后释放；child 再次开 turn 则撤销。
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    this.detachedTerminalAt.set(sessionId, Date.now());
  } else if (event.type === SessionEventType.TurnStarted) {
    this.detachedTerminalAt.delete(sessionId);
  }
  this.ingest(sessionId, event);
}

/**
 * 低频 tick 兜底：释放已终态、无订阅者、且没有自己 record 的 detached child publisher。
 * 释放后再被订阅走既有 cold resume（child 作为 subagent_child 持久化在 session store）。返回释放数。
 */

export function pruneDetachedChildPublishers(
  this: ConversationV4GatewayMethodsContext,
  nowMs: number = Date.now(),
  graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
): number {
  let released = 0;
  for (const [childId, terminalAt] of [...this.detachedTerminalAt]) {
    if (nowMs - terminalAt < graceMs) continue;
    if (this.host.sessionExists(childId)) continue;
    if (this.publishers.get(childId)?.hasSubscribers()) continue;
    this.releaseDetachedChild(childId);
    released += 1;
  }
  return released;
}

export function releaseDetachedChild(
  this: ConversationV4GatewayMethodsContext,
  childId: string,
): void {
  this.host.onDebug?.(`release detached live child publisher session=${childId}`);
  this.cleanupSessionRuntime(childId, { clearCommandInbox: false, notifyIndexRemoved: false });
}
