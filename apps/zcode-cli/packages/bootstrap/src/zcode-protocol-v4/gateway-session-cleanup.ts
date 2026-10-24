// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import { ProjectionEventCommitWaitError } from "./gateway-support.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
/** 会话关闭：清 publisher 与其全部订阅调度；hydration 标记同清（重开走冷启动重建）；
 *  并从其 workspace index 移除该会话（session.removed 推给列表订阅者）。 */

export function disposeSession(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  options: { deleted?: boolean } = {},
): void {
  this.cleanupSessionRuntime(sessionId, {
    clearCommandInbox: false,
    notifyIndexRemoved: options.deleted === true,
  });
}

/**
 * Resident 容量去激活：与 disposeSession 相同的内存运行态清理，但**不**从 sessions-index
 * 移除会话（不发 session.removed）——去激活是纯内存优化，侧边栏列表项必须原样
 * 保留，再次订阅经冷恢复透明重建。
 */

export function deactivateSession(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): void {
  this.cleanupSessionRuntime(sessionId, {
    clearCommandInbox: true,
    notifyIndexRemoved: false,
  });
}

/**
 * Resident 回收纯预检：调用方可在拆 runtime event subscription 前拒绝不安全回收。
 * deactivateSession 内仍复用同一校验，防止未来新增调用方绕过执行面 preflight。
 */

export function assertSessionRuntimeDeactivatable(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): void {
  if (!this.inbox.hasPinnedSessionState(sessionId)) return;
  throw new Error(`Session command inbox is still pinned: ${sessionId}`);
}

/** Resident 回收判定：该会话是否还有 conversation 订阅者（桌面 tab / 手机 remote）。 */

export function hasConversationSubscribers(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): boolean {
  return this.publishers.get(sessionId)?.hasSubscribers() ?? false;
}

/**
 * 内存诊断计数器。只读 size，不触碰状态。
 * detachedLive 用于观察子 session publisher 是否随父 session 释放。
 */

export function collectMemoryDiagnostics(
  this: ConversationV4GatewayMethodsContext,
): Record<string, number> {
  return {
    publishers: this.publishers.size,
    detachedLive: this.detachedLiveSessions.size,
    detachedTerminal: this.detachedTerminalAt.size,
    rawSeqStates: this.rawSequenceStates.size,
  };
}

export function cleanupSessionRuntime(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  options: { clearCommandInbox: boolean; notifyIndexRemoved: boolean },
): void {
  if (options.clearCommandInbox) {
    // 清掉 in-flight/live 命令会破坏幂等与 FIFO。resident facts 已在回收前
    // 拦截；若这里仍命中，必须在拆 publisher 之前失败，不能留下半清状态。
    this.assertSessionRuntimeDeactivatable(sessionId);
  }
  this.rejectProjectionEventWaiters(
    sessionId,
    new ProjectionEventCommitWaitError(
      "fault.projectionEventCommit.disposed",
      `conversation session disposed while waiting for projection event commit: ${sessionId}`,
    ),
  );
  this.attachmentUploads.clearSession(sessionId);
  for (const [key, entry] of this.binaryReadCache) {
    if (entry.sessionId === sessionId) this.deleteBinaryReadCacheEntry(key);
  }
  if (options.notifyIndexRemoved) {
    // 先取 workspaceId（会话 record 还在时），把 session.removed 推给列表订阅者。
    try {
      const workspaceId = this.host.getSessionWorkspaceId?.(sessionId) ?? null;
      if (workspaceId !== null) {
        const indexPublisher = this.indexPublishers.get(workspaceId);
        // 无订阅者时也必须先更新 projection，避免已有 publisher 在下次
        // subscribe 的 snapshot 中复活已删除会话；flushIndex 对空订阅自然 no-op。
        if (indexPublisher?.removeSession(sessionId)) {
          this.flushIndex(workspaceId);
        }
      }
    } catch (error) {
      this.host.onError?.("v4.sessionsIndex.remove", error);
    }
  }
  this.indexFanoutThrottle.clearSession(sessionId);
  for (const [routeKey, state] of this.flushStates) {
    if (state.sessionId !== sessionId) continue;
    if (state.timer) clearTimeout(state.timer);
    this.flushStates.delete(routeKey);
  }
  this.publishers.delete(sessionId);
  this.hydratedSessions.delete(sessionId);
  const hydrationBuffer = this.hydrationBuffers.get(sessionId);
  if (hydrationBuffer) hydrationBuffer.cancelled = true;
  this.hydrationBuffers.delete(sessionId);
  this.hydrationInFlight.delete(sessionId);
  this.readyFlights.delete(sessionId);
  this.historyOpenings.get(sessionId)?.cancel();
  this.rawSequenceStates.delete(sessionId);
  if (options.clearCommandInbox) this.inbox.clearSession(sessionId);
  this.telemetryNormalizer.clearSession(sessionId);
  this.detachedLiveSessions.delete(sessionId);
  this.projectionFaultedSessions.delete(sessionId);
  // detached child 归属清理：自己作为 child 从父表摘除；作为父则连带释放没有 record 的 child。
  this.detachedTerminalAt.delete(sessionId);
  const parentId = this.detachedChildParent.get(sessionId);
  if (parentId !== undefined) {
    this.detachedChildParent.delete(sessionId);
    const siblings = this.detachedChildrenByParent.get(parentId);
    siblings?.delete(sessionId);
    if (siblings && siblings.size === 0) this.detachedChildrenByParent.delete(parentId);
  }
  const children = this.detachedChildrenByParent.get(sessionId);
  if (children) {
    this.detachedChildrenByParent.delete(sessionId);
    for (const childId of children) {
      this.detachedChildParent.delete(childId);
      if (this.host.sessionExists(childId)) continue;
      this.releaseDetachedChild(childId);
    }
  }
}

export function dispose(this: ConversationV4GatewayMethodsContext): void {
  this.disposed = true;
  this.localTtft.clear();
  for (const sessionId of this.projectionEventCommitWaiters.keys()) {
    this.rejectProjectionEventWaiters(
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.gatewayDisposed",
        "conversation gateway disposed while waiting for projection event commit",
      ),
    );
  }
  clearInterval(this.attachmentPruneTimer);
  this.indexFanoutThrottle.clear();
  this.attachmentUploads.clear();
  this.binaryReadCache.clear();
  this.binaryReadCacheBytes = 0;
  for (const state of this.flushStates.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  this.flushStates.clear();
  this.publishers.clear();
  this.hydratedSessions.clear();
  for (const buffer of this.hydrationBuffers.values()) buffer.cancelled = true;
  this.hydrationBuffers.clear();
  this.hydrationInFlight.clear();
  this.readyFlights.clear();
  for (const opening of this.historyOpenings.values()) opening.cancel();
  this.historyOpenings.clear();
  this.rawSequenceStates.clear();
  this.telemetryEventIds.clear();
  this.detachedLiveSessions.clear();
  this.detachedChildParent.clear();
  this.detachedChildrenByParent.clear();
  this.detachedTerminalAt.clear();
  this.projectionFaultedSessions.clear();
  this.coldResume.clear();
  this.indexPublishers.dispose();
  this.configPublishers.clear();
  this.pausedConnections.clear();
}
