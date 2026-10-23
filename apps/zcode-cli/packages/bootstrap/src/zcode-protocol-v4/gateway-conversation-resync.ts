// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import type { RoutedTopicFrame } from "@zcode/shared/zcode-protocol-v4";

import {
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  v4ConversationResyncParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";

import { subscriptionRouteKey } from "./gateway-support.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
import type { V4SubscribeDispatchResult } from "./gateway-support.js";
/**
 * v4/conversation/resync：按 owned topic/connection 精确命中现有 subscription，
 * 保持 subId/profile 不变，从客户端 base 重新裁决 resume/snapshot。
 */

export function resyncReserved(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): V4SubscribeDispatchResult<RoutedTopicFrame> {
  const params = v4ConversationResyncParamsSchema.parse(rawParams);
  const request = {
    base: params.base,
    ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
  };
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId !== null) {
    const publisher = this.publishers.get(sessionId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
    const flushState = this.flushStates.get(routeKey);
    if (flushState?.timer) {
      clearTimeout(flushState.timer);
      flushState.timer = null;
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return this.subscribeDispatch(result.ack, result.reservation, () => {
        const state = this.flushStates.get(routeKey);
        if (state) this.scheduleFlush(routeKey, state, publisher);
      });
    } catch (error) {
      // physical encode 在 ACK admission 前失败时，same-sub recovery
      // 不能留下新的 inFlight 或取消旧 online flush；原子恢复旧状态后重挂 timer。
      result.rollback();
      if (flushState) this.scheduleFlush(routeKey, flushState, publisher);
      throw error;
    }
  }

  const indexWorkspaceId = parseSessionsIndexTopic(params.topic);
  if (indexWorkspaceId !== null) {
    const publisher = this.indexPublishers.get(indexWorkspaceId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return this.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this.flushIndex(indexWorkspaceId),
      );
    } catch (error) {
      result.rollback();
      throw error;
    }
  }

  const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
  if (configWorkspaceId !== null) {
    const publisher = this.configPublishers.get(configWorkspaceId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return this.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this.flushConfig(configWorkspaceId),
      );
    } catch (error) {
      result.rollback();
      throw error;
    }
  }
  throw new Error(`Unsupported topic: ${params.topic}`);
}
