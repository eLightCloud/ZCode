// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import { SessionEventType } from "@zcode/contracts";

import {
  PROJECTION_EVENT_COMMIT_TIMEOUT_MS,
  ProjectionEventCommitWaitError,
} from "./gateway-support.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
import type { ProjectionEventCommitWaiter } from "./gateway-support.js";
/** 等待指定 raw event 真正完成 reorder drain + publisher projection apply。 */

export function waitForProjectionEventCommit(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  eventId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (this.disposed) {
    return Promise.reject(
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.gatewayDisposed",
        "conversation gateway is disposed",
      ),
    );
  }
  const state = this.getOrCreateRawSequenceState(sessionId);
  if (state.appliedEventIds.has(eventId)) return Promise.resolve();
  const failed = state.failedEventById.get(eventId);
  if (failed) return Promise.reject(failed);
  if (options.signal?.aborted) {
    return Promise.reject(
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.aborted",
        `projection event commit wait aborted: ${eventId}`,
        { cause: options.signal.reason },
      ),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const byEvent = this.projectionEventCommitWaiters.get(sessionId) ?? new Map();
    this.projectionEventCommitWaiters.set(sessionId, byEvent);
    const waiters = byEvent.get(eventId) ?? new Set();
    byEvent.set(eventId, waiters);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      waiters.delete(waiter);
      if (waiters.size === 0) byEvent.delete(eventId);
      if (byEvent.size === 0) this.projectionEventCommitWaiters.delete(sessionId);
    };
    const waiter: ProjectionEventCommitWaiter = {
      resolve: () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    };
    const onAbort = () => {
      // 只 reject 当前 waiter 会让 raw gap 中的 TurnStarted 继续存活；
      // command 已 cancelled 后补齐 gap，迟到事件仍会进入 canonical projection。
      // event failure 必须固化到 sequence state，后续 drain 只推进 cursor、不再 apply。
      this.rejectProjectionEventCommit(
        sessionId,
        eventId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.aborted",
          `projection event commit wait aborted: ${eventId}`,
          { cause: options.signal?.reason },
        ),
      );
    };
    const timeout = setTimeout(() => {
      this.rejectProjectionEventCommit(
        sessionId,
        eventId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.timeout",
          `projection event commit wait timed out: ${eventId}`,
        ),
      );
    }, PROJECTION_EVENT_COMMIT_TIMEOUT_MS);
    timeout.unref?.();
    waiters.add(waiter);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 授权已经提交到任务事务，失败重试必须重放权威日志，不能再次提权或丢弃提交事实。 */

export async function waitForPermissionGrantCommit(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  eventId: string,
): Promise<void> {
  const state = this.getOrCreateRawSequenceState(sessionId);
  if (state.failedEventById.has(eventId)) {
    const event = state.recentRawEventsById.get(eventId);
    if (
      event?.type !== SessionEventType.SessionModeChanged ||
      !(event.payload as { permissionGrant?: unknown }).permissionGrant
    ) {
      throw new Error("Permission grant event unavailable for recovery");
    }
    await this.hydrationInFlight.get(sessionId);
    this.hydratedSessions.delete(sessionId);
    await this.hydratePublisher(sessionId, undefined, true);
  }
  await this.waitForProjectionEventCommit(sessionId, eventId);
}

export function resolveProjectionEventCommit(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  eventId: string,
): void {
  const state = this.getOrCreateRawSequenceState(sessionId);
  state.failedEventById.delete(eventId);
  state.appliedEventIds.add(eventId);
  const waiters = this.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
  if (!waiters) return;
  for (const waiter of [...waiters]) waiter.resolve();
}

export function rejectProjectionEventCommit(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  eventId: string,
  error: Error,
): void {
  const state = this.getOrCreateRawSequenceState(sessionId);
  state.failedEventById.set(eventId, error);
  const waiters = this.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
  if (!waiters) return;
  for (const waiter of [...waiters]) waiter.reject(error);
}

export function rejectProjectionEventWaiters(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  error: Error,
): void {
  const byEvent = this.projectionEventCommitWaiters.get(sessionId);
  if (!byEvent) return;
  for (const waiters of byEvent.values()) {
    for (const waiter of [...waiters]) waiter.reject(error);
  }
  this.projectionEventCommitWaiters.delete(sessionId);
}
