// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。
import type { SessionEvent, TargetChangedPayload } from "@zcode/contracts";

import { SessionEventType } from "@zcode/contracts";

import { ProjectionPayloadTooLargeError } from "./conversation-topic-publisher.js";

import { MAX_TELEMETRY_EVENT_IDS, ProjectionEventCommitWaitError } from "./gateway-support.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
/** 权威事件入口：投影推进 + 各订阅者按 profile.flushWindowMs 调度打帧。 */

export function ingest(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  event: SessionEvent,
): void {
  if (this.disposed) return;
  const hydrationBuffer = this.hydrationBuffers.get(sessionId);
  if (hydrationBuffer) {
    const eventId = String(event.id);
    if (hydrationBuffer.eventIds.has(eventId)) return;
    // 先记 raw fact；它可能因前序尚未到而暂时不进 publisher。
    hydrationBuffer.eventIds.add(eventId);
    hydrationBuffer.rawEvents.push(event);
  }
  this.emitLiveTelemetryFact(sessionId, event);
  for (const normalizedEvent of this.normalizeRuntimeEventSequence(sessionId, event)) {
    try {
      this.localTtft.event(sessionId, normalizedEvent);
    } catch (error) {
      try {
        this.host.onError?.("v4.localTtft.observe", error);
      } catch {
        /* 诊断回调也不能阻断实际内容。 */
      }
    }
    this.ingestNormalizedEvent(sessionId, normalizedEvent);
  }
}

export function emitLiveTelemetryFact(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  event: SessionEvent,
): void {
  const eventId = String(event.id);
  // 主 session 与 detached child 各自维护事件序列，eventId 不能假设跨
  // session 全局唯一。旧去重只用 eventId，会把 child 的同号事件误判成主会话重放，
  // 导致前台 Subagent 的真实轮次事实被静默丢弃。
  const telemetryEventKey = `${sessionId}\0${eventId}`;
  if (this.telemetryEventIds.has(telemetryEventKey)) return;
  this.telemetryEventIds.add(telemetryEventKey);
  if (this.telemetryEventIds.size > MAX_TELEMETRY_EVENT_IDS) {
    const oldest = this.telemetryEventIds.values().next().value;
    if (typeof oldest === "string") this.telemetryEventIds.delete(oldest);
  }
  try {
    const config =
      this.publishers.get(sessionId)?.getSnapshot().config ??
      this.host.getSessionConfigSeed?.(sessionId) ??
      undefined;
    const fact = this.telemetryNormalizer.normalize(sessionId, event, {
      memoryEnabled: this.host.getSessionMemoryEnabled?.(sessionId),
      modelName: config?.model,
      modelProvider: config?.provider,
    });
    if (fact) {
      this.host.emitConversationTelemetryFact?.(fact);
    }
  } catch (error) {
    // 轮次事实绝不能反向阻断 conversation 投影；严格 schema 失败只记录诊断。
    this.host.onError?.("v4.telemetry.normalize", error);
  }
  try {
    const observation = this.cuaPermissionNormalizer.normalize(sessionId, event);
    if (observation) this.host.emitCuaPermissionObservation?.(observation);
  } catch (error) {
    // 权限观察只是 live UI 提示，schema 或投影异常不能阻断 conversation 主链路。
    this.host.onError?.("v4.cuaPermissionObservation.normalize", error);
  }
}

export function ingestNormalizedEvent(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  event: SessionEvent,
): void {
  const publisher = this.ensurePublisher(sessionId);
  const promotedQueueRemoval =
    event.type === SessionEventType.TurnSteerDiscarded &&
    (event.payload as { reason?: string }).reason === "promoted";
  const removedQueueItems =
    event.type === SessionEventType.TurnSteerDrained ||
    event.type === SessionEventType.TurnSteerDiscarded
      ? ((event.payload as { pendingInputIds?: string[] }).pendingInputIds ?? []).flatMap(
          (queueItemId) => {
            const item = publisher
              .getSnapshot()
              .queue.items.find((candidate) => candidate.queueItemId === queueItemId);
            return item ? [item] : [];
          },
        )
      : [];
  try {
    publisher.ingest(event);
  } catch (error) {
    const commitError =
      error instanceof ProjectionEventCommitWaitError
        ? error
        : new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.applyFailed",
            `projection failed to apply event ${String(event.id)}`,
            { cause: error },
          );
    this.rejectProjectionEventCommit(sessionId, String(event.id), commitError);
    if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
    this.host.onError?.("v4.projection.payloadTooLarge", error);
    if (!this.projectionFaultedSessions.has(sessionId)) {
      this.projectionFaultedSessions.add(sessionId);
      void Promise.resolve(
        this.host.terminateTurnForProjectionFault?.(sessionId, error.reasonCode),
      ).catch((terminateError) => {
        this.host.onError?.("v4.projection.terminate", terminateError);
      });
    }
    return;
  }
  this.resolveProjectionEventCommit(sessionId, String(event.id));
  if (
    !this.hydrationBuffers.has(sessionId) &&
    (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError)
  ) {
    try {
      this.host.onHighspeedTurnTerminal?.(sessionId, event, publisher.getSnapshot());
    } catch (error) {
      this.host.onError?.("v4.projection.highspeedMetrics", error);
    }
  }
  if (
    event.type === SessionEventType.TargetChanged &&
    (event.payload as TargetChangedPayload).target?.status === "complete"
  ) {
    try {
      this.host.onTargetCompleted?.(sessionId, event);
    } catch (error) {
      this.host.onError?.("v4.projection.targetCompleted", error);
    }
  }
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    this.projectionFaultedSessions.delete(sessionId);
  }
  if (event.type === SessionEventType.TurnSteerQueued) {
    const queueItemId = (event.payload as { pendingInputId?: string }).pendingInputId;
    const item = queueItemId
      ? publisher
          .getSnapshot()
          .queue.items.find((candidate) => candidate.queueItemId === queueItemId)
      : undefined;
    if (item) this.inbox.pinLiveInput(sessionId, item);
  }
  if (!promotedQueueRemoval) {
    if (removedQueueItems.length > 0) {
      // delete/clear 已先把 durable session_input 写成 cancelled，但本 session
      // 的 persistent command index 可能缓存过旧空结果。必须先失效再解除 live pin，
      // 否则 LRU 淘汰后同 commandId 查询仍可能 unknown 并被重复执行。
      this.host.invalidatePersistentCommandFacts?.(sessionId);
    }
    for (const item of removedQueueItems) {
      this.inbox.releaseLiveInput({
        sessionId,
        commandId: item.sourceCommandId,
      });
    }
  }
  if (event.type === SessionEventType.SessionInputPromoted) {
    const sourceCommandId = (event.payload as { sourceCommandId?: string }).sourceCommandId;
    if (sourceCommandId) {
      // persistent index 可能早于本条 user message 被 query 过；先失效再解 pin，
      // 后续 LRU 淘汰回源时才能重读刚提交的 transcript，而不是命中旧空 seed。
      this.host.invalidatePersistentCommandFacts?.(sessionId);
      this.inbox.releaseLiveInput({ sessionId, commandId: sourceCommandId });
    }
  }
  // assistant 守恒：投影拒收了正文流（订阅中途建 publisher、错过
  // TurnStarted 的典型形态）→ 撤销 hydrated 标记，下次订阅强制从持久事实重新
  // hydration 补齐缺段——静默丢会让内容缺失直到用户手动刷新才恢复。
  if (publisher.getDroppedContentStreamEventCount() > 0 && this.hydratedSessions.has(sessionId)) {
    this.hydratedSessions.delete(sessionId);
    this.host.onError?.(
      "v4.assistantConservation",
      new Error(
        `projection dropped content stream events for session ${sessionId}; scheduling re-hydration`,
      ),
    );
  }
  for (const [routeKey, state] of this.flushStates) {
    if (state.sessionId !== sessionId) continue;
    this.scheduleFlush(routeKey, state, publisher);
  }
  // sessions-index fan-out（防御式：任何异常都不能打断 conversation 主路径）。
  this.fanOutToIndex(sessionId, event);
}
