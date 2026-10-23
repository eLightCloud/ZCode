// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";

import { v4ConnectionFlowParamsSchema } from "@zcode/shared/zcode-protocol-v4";

import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
import type { FlushState } from "./gateway-support.js";
export function setConnectionFlowState(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): void {
  const params = v4ConnectionFlowParamsSchema.parse(rawParams);
  if (params.state === "closed") {
    this.pausedConnections.delete(params.connectionId);
    this.clearConnectionFlushTimers(params.connectionId);
    this.attachmentUploads.clearConnection(params.connectionId);
    return;
  }
  if (params.state === "saturated") {
    if (this.pausedConnections.has(params.connectionId)) return;
    this.pausedConnections.add(params.connectionId);
    this.clearConnectionFlushTimers(params.connectionId);
    return;
  }
  if (!this.pausedConnections.delete(params.connectionId)) return;
  this.flushConnection(params.connectionId);
}

export function clearConnectionFlushTimers(
  this: ConversationV4GatewayMethodsContext,
  connectionId: string,
): void {
  for (const state of this.flushStates.values()) {
    if (state.connectionId !== connectionId || state.timer === null) continue;
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export function flushConnection(
  this: ConversationV4GatewayMethodsContext,
  connectionId: string,
): void {
  for (const [routeKey, state] of this.flushStates) {
    if (state.connectionId !== connectionId) continue;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const publisher = this.publishers.get(state.sessionId);
    if (!publisher?.hasSubscription(state.subscriptionId, connectionId)) {
      this.flushStates.delete(routeKey);
      continue;
    }
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) continue;
    try {
      this.emitReservation(reservation);
    } catch (error) {
      this.host.onError?.("v4.frame.emit", error);
    }
  }
  for (const workspaceId of this.indexPublishers.keys()) {
    this.flushIndex(workspaceId, connectionId);
  }
  for (const workspaceId of this.configPublishers.keys()) {
    this.flushConfig(workspaceId, connectionId);
  }
}

/** 测试探针：立即排空某订阅（绕过定时器）。 */

export function flushNow(
  this: ConversationV4GatewayMethodsContext,
  subscriptionId: string,
): ConversationTopicFrame | null {
  const match = [...this.flushStates.entries()].find(
    ([, state]) => state.subscriptionId === subscriptionId,
  );
  const state = match?.[1];
  if (!state) return null;
  if (this.pausedConnections.has(state.connectionId)) return null;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const publisher = this.publishers.get(state.sessionId);
  if (!publisher) return null;
  const reservation = publisher.reserveFlush(state.subscriptionId);
  if (!reservation || !reservation.commit()) return null;
  return reservation.frame;
}

export function scheduleFlush(
  this: ConversationV4GatewayMethodsContext,
  routeKey: string,
  state: FlushState,
  publisher: ConversationTopicPublisher,
): void {
  if (this.pausedConnections.has(state.connectionId)) return;
  if (state.timer !== null) return;
  const timer = setTimeout(() => {
    state.timer = null;
    // timer 排队后可能收到 SAT；reserve 前必须二次检查，不能产生竞态帧。
    if (this.pausedConnections.has(state.connectionId)) return;
    // 惰性清理：订阅已被替换/退订→ 删调度状态，不产帧。
    if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) {
      this.flushStates.delete(routeKey);
      return;
    }
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) return;
    try {
      this.emitReservation(reservation);
    } catch (error) {
      this.host.onError?.("v4.frame.emit", error);
    }
  }, state.flushWindowMs);
  // CLI 进程退出不被 flush 定时器挂住。
  timer.unref?.();
  state.timer = timer;
}

import type { RoutedTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { localTtftFactsSchema, parseConversationTopic } from "@zcode/shared/zcode-protocol-v4";
import { encodeReservedTopicFrame, subscriptionRouteKey } from "./gateway-support.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
export function emitReservation<F extends RoutedTopicFrame>(
  this: ConversationV4GatewayMethodsContext,
  reservation: TopicFrameReservation<F>,
): boolean {
  // resync/subscribe recovery 已进入 request-scoped outbox 时，online
  // flush 若复用同一 inFlight 会让 physical wire 抢在 ACK response 前出站。
  if (this.controlReservations.has(reservation)) return false;
  const sessionId = parseConversationTopic(reservation.frame.topic);
  const route = this.flushStates.get(
    subscriptionRouteKey(
      reservation.frame.topic,
      reservation.frame.subscriptionId,
      sessionId
        ? (this.publishers
            .get(sessionId)
            ?.connectionIdForSubscription(reservation.frame.subscriptionId) ?? "")
        : "",
    ),
  );
  if (
    sessionId &&
    route?.deliveryProfile === "continuous" &&
    reservation.deliveryKind === "online" &&
    reservation.frame.payload.kind === "deltas" &&
    this.localTtft.forSession(sessionId)
  ) {
    const rows = this.publishers.get(sessionId)?.getSnapshot().rows.window ?? [];
    const turns = new Set<string>();
    for (const delta of reservation.frame.payload.deltas) {
      if (delta.op === "row.appended" || delta.op === "row.upserted") turns.add(delta.row.turnId);
      else if (delta.op === "row.delta") {
        const row = rows.find((item) => item.rowId === delta.rowId);
        if (row) turns.add(row.turnId);
      }
    }
    const related = rows
      .filter((row) => row.kind === "turnHeader" && turns.has(row.turnId))
      .flatMap((header) =>
        header.kind === "turnHeader" && header.sourceCommandId
          ? [this.localTtft.forSession(sessionId, header.sourceCommandId)]
          : [],
      )
      .filter((facts) => facts !== undefined);
    const candidates = related.length ? related : [this.localTtft.forSession(sessionId)];
    const observations: import("@zcode/shared").LocalTtftFacts[] = [];
    for (const facts of candidates) {
      if (!facts || observations.some((item) => item.observationId === facts.observationId))
        continue;
      const header = rows.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === facts.commandId,
      );
      const observation = localTtftFactsSchema.safeParse({
        ...facts,
        ...(this.host.cliVersion ? { cliVersion: this.host.cliVersion } : {}),
        ...(header ? { productTurnId: header.turnId } : {}),
      });
      // 转正前后的内容可能被同批发送；按实际 row 所属原输入携带事实，不能取最新队列项。
      if (observation.success) observations.push(observation.data);
    }
    if (observations.length) {
      (reservation.frame as ConversationTopicFrame).ttft = observations[0];
      if (observations.length > 1)
        (reservation.frame as ConversationTopicFrame).ttftRelated = observations.slice(1, 17);
    }
  }
  const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
  for (const wire of wires) this.host.emitWireFrame(wire);
  return reservation.commit();
}
