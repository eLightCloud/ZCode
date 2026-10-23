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

import {
  DELIVERY_PROFILES,
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  v4ConversationSubscribeParamsSchema,
  v4ConversationUnsubscribeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";

import { subscriptionRouteKey } from "./gateway-support.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
import type { V4SubscribeDispatchResult } from "./gateway-support.js";
/** v4/conversation/subscribe：裁决 + server 内部 initial frame，公共响应由 server 只取 ACK。 */

export async function subscribe(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
  const dispatch = await this.subscribeReserved(rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeReserved(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId === null) {
    throw new Error(`Unsupported topic: ${params.topic}`);
  }
  const isLiveConversation = this.hasLiveConversation(sessionId);
  this.host.onDebug?.(
    `subscribe conversation session=${sessionId} coldResume=${String(!isLiveConversation)}`,
  );
  // Hydration：首次订阅时从权威来源重建投影。
  // - 无 publisher（cold）→ 建 + 重放。
  // - 有 publisher 但事件日志覆盖不了 transcript（fork child：resume 的 ingest 抢先
  //   建了个只含 fork 事件的 cold publisher）→ 用 transcript 合成**重建**。
  // - 有 publisher 且事件日志完整（流式 live）→ 保留，重放会双计且打断流。
  const restoreStartedAt = performance.now();
  const existingReady = this.readyFlights.get(sessionId);
  const publisher = existingReady
    ? await existingReady
    : !isLiveConversation
      ? await this.ensureColdReadyPublisher(sessionId, params.resumeThoughtLevel, params.workspace)
      : await this.hydratePublisher(sessionId);
  const cliSessionRestoreMs = !isLiveConversation
    ? Math.max(0, Math.round(performance.now() - restoreStartedAt))
    : undefined;
  // 旧入口允许 UI 自选 deliveryProfile，桌面调用遗漏时还会默认成
  // replayable。现在只认 host attachment 注入的可信 clientMode。
  const profileName = params.clientMode === "desktop-continuous" ? "continuous" : "replayable";
  // subscribeReserved 已构建 wire projection；若在它之后才开始计时，大会话的
  // 行过滤/窗口截断会落在 restore 与 encode 两段之外。起点必须覆盖构建与 physical encode。
  const initialFrameEncodeStartedAt = performance.now();
  const result = publisher.subscribeReserved({
    connectionId: params.connectionId,
    base: params.base,
    deliveryProfile: profileName,
    // 与 clientMode 同族的可信注入：能力位来自该连接的 clientHello，缺席一律按旧消费者办
    // （整键 patch + 旧界裁剪）。resync / rehydrate 沿用订阅上已记下的这一位，不再重取。
    workflowRunDeltas: params.workflowRunDeltas === true,
  });
  const routeKey = subscriptionRouteKey(
    params.topic,
    result.ack.subscriptionId,
    params.connectionId,
  );
  let dispatch: V4SubscribeDispatchResult<ConversationTopicFrame>;
  try {
    dispatch = this.subscribeDispatch(result.ack, result.reservation, () => {
      const state = this.flushStates.get(routeKey);
      if (state) this.scheduleFlush(routeKey, state, publisher);
    });
    dispatch.ack = {
      ...dispatch.ack,
      openTiming: {
        version: 1,
        ...(cliSessionRestoreMs !== undefined ? { cliSessionRestoreMs } : {}),
        initialFrameEncodeMs: Math.max(
          0,
          Math.round(performance.now() - initialFrameEncodeStartedAt),
        ),
        sessionRuntimeState: isLiveConversation ? "warm" : "cold",
        snapshotRowCount: publisher.getSnapshot().rows.window.length,
      },
    };
  } catch (error) {
    // 重订 initial encode 失败时客户端仍持有旧 subId；replacement 必须
    // 原子 rollback，旧 publisher subscription 与 flush timer 都继续有效。
    result.rollback();
    throw error;
  }
  // encode 成功后 replacement 才 admission；此时再清旧调度状态，失败路径不碰旧 owner。
  for (const [staleRouteKey, staleState] of this.flushStates) {
    if (staleState.sessionId !== sessionId) continue;
    if (publisher.hasSubscription(staleState.subscriptionId, staleState.connectionId)) {
      continue;
    }
    if (staleState.timer) clearTimeout(staleState.timer);
    this.flushStates.delete(staleRouteKey);
  }
  this.flushStates.set(routeKey, {
    sessionId,
    topic: params.topic,
    subscriptionId: result.ack.subscriptionId,
    connectionId: params.connectionId,
    deliveryProfile: profileName,
    flushWindowMs: DELIVERY_PROFILES[profileName].flushWindowMs,
    timer: null,
  });
  return dispatch;
}

/** v4/conversation/unsubscribe。 */

export function unsubscribe(this: ConversationV4GatewayMethodsContext, rawParams: unknown): void {
  const params = v4ConversationUnsubscribeParamsSchema.parse(rawParams);
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId === null) {
    const workspaceId = parseSessionsIndexTopic(params.topic);
    if (workspaceId !== null) {
      this.indexPublishers
        .get(workspaceId)
        ?.unsubscribe(params.subscriptionId, params.connectionId);
      return;
    }
    const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
    if (configWorkspaceId !== null) {
      this.configPublishers
        .get(configWorkspaceId)
        ?.unsubscribe(params.subscriptionId, params.connectionId);
    }
    return;
  }
  const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
  const state = this.flushStates.get(routeKey);
  if (!state) return;
  if (state?.timer) clearTimeout(state.timer);
  this.flushStates.delete(routeKey);
  // 裸 subscriptionId 在不同 topic/connection 可碰撞；旧网关先按 subId
  // 反查再对三类 publisher 广撒网，会删掉别的连接。topic + connection 必须同时命中。
  this.publishers.get(sessionId)?.unsubscribe(params.subscriptionId, params.connectionId);
}
