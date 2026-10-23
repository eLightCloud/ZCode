// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import type {
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";

import {
  parseWorkspaceConfigTopic,
  v4ConversationSubscribeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";

import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
import type { V4SubscribeDispatchResult } from "./gateway-support.js";
/**
 * workspace-config 订阅：订阅某 workspace 的配置目录（与 conversation subscribe 并列，
 * 同一 RPC 方法按 topic 前缀分派）。订阅时经宿主钩子拉取当前配置作种子。
 */

export async function subscribeWorkspaceConfig(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
  const dispatch = await this.subscribeWorkspaceConfigReserved(rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeWorkspaceConfigReserved(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const workspaceId = parseWorkspaceConfigTopic(params.topic);
  if (workspaceId === null) {
    throw new Error(`Not a workspace-config topic: ${params.topic}`);
  }
  const publisher = await this.ensureConfigPublisher(workspaceId);
  const result = publisher.subscribeReserved(params.connectionId, params.base);
  try {
    return this.subscribeDispatch(
      {
        subscriptionId: result.subscriptionId,
        mode: result.mode,
        logEpoch: publisher.logEpoch,
      },
      result.reservation,
      () => this.flushConfig(workspaceId),
    );
  } catch (error) {
    // 与 sessions-index 同一原子边界：encode 失败 = subscribe 未 admission。
    result.rollback();
    throw error;
  }
}

/**
 * 配置目录发布入口（宿主在 provider registry 应用 / workspace 默认项变更后调用，
 * 直接携带已构建好的目录，不回头重拉宿主，避免重复 buildWorkspaceState 的临时 app 成本）。
 * conflation 在 publisher 内完成（未变化不产帧）；无 publisher 时同步建一个空种子的
 * publisher 存住最新态，后续订阅者据此拿到完整 snapshot。
 */

export function publishWorkspaceConfig(
  this: ConversationV4GatewayMethodsContext,
  workspaceId: string,
  state: WorkspaceConfigState,
): void {
  if (this.disposed) return;
  let publisher = this.configPublishers.get(workspaceId);
  if (!publisher) {
    publisher = new WorkspaceConfigPublisher(
      workspaceId,
      this.createLogEpoch(`workspace-config/${workspaceId}`),
      this.now,
    );
    this.configPublishers.set(workspaceId, publisher);
  }
  try {
    if (publisher.publish(state)) this.flushConfig(workspaceId);
  } catch (error) {
    this.host.onError?.("v4.workspaceConfig.publish", error);
  }
}

export async function pullWorkspaceConfig(
  this: ConversationV4GatewayMethodsContext,
  workspaceId: string,
): Promise<WorkspaceConfigState | null> {
  if (!this.host.getWorkspaceConfig) return null;
  return (await this.host.getWorkspaceConfig(workspaceId)) ?? null;
}

/** 建/取某 workspace 的 config publisher；建时经宿主钩子拉取当前目录作种子。 */

export async function ensureConfigPublisher(
  this: ConversationV4GatewayMethodsContext,
  workspaceId: string,
): Promise<WorkspaceConfigPublisher> {
  const existing = this.configPublishers.get(workspaceId);
  if (existing) return existing;
  const publisher = new WorkspaceConfigPublisher(
    workspaceId,
    this.createLogEpoch(`workspace-config/${workspaceId}`),
    this.now,
  );
  const seed = await this.pullWorkspaceConfig(workspaceId).catch((error) => {
    this.host.onError?.("v4.workspaceConfig.seed", error);
    return null;
  });
  if (seed) publisher.publish(seed);
  // await 期间的并发订阅可能已注册同 workspace publisher → 以先注册者为准。
  const raced = this.configPublishers.get(workspaceId);
  if (raced) return raced;
  this.configPublishers.set(workspaceId, publisher);
  return publisher;
}

/** 把某 workspace config publisher 的未发增量帧推给所有订阅者。 */

export function flushConfig(
  this: ConversationV4GatewayMethodsContext,
  workspaceId: string,
  onlyConnectionId?: string,
): void {
  const publisher = this.configPublishers.get(workspaceId);
  if (!publisher) return;
  for (const subscriptionId of publisher.subscriptionIds()) {
    const connectionId = publisher.connectionIdForSubscription(subscriptionId);
    if (
      connectionId === null ||
      this.pausedConnections.has(connectionId) ||
      (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
    ) {
      continue;
    }
    const reservation = publisher.reserveFlush(subscriptionId);
    if (!reservation) continue;
    try {
      this.emitReservation(reservation);
    } catch (error) {
      this.host.onError?.("v4.workspaceConfig.emit", error);
    }
  }
}
