// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。
import type { MessageWithParts } from "@zcode/contracts";

import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

import type { ZCodeWorkspaceRef } from "@zcode/shared";

import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

import type { SessionUsageSeed } from "./product-projection.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
import type { HydrationBuffer } from "./gateway-support.js";
export function ensurePublisher(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): ConversationTopicPublisher {
  let publisher = this.publishers.get(sessionId);
  if (!publisher) {
    publisher = new ConversationTopicPublisher(sessionId, this.createLogEpoch(sessionId), {
      now: this.now,
    });
    this.publishers.set(sessionId, publisher);
    // config 种子：创建即注入 runtime 真值（不产 delta / 不 bump revision）。
    this.seedPublisherConfig(sessionId, publisher);
  }
  return publisher;
}

/**
 * config 种子注入（防御式：种子失败不打断 conversation 主路径）。
 * 幂等且事件优先（seedConfig 跳过事件触碰过的字段），故在 publisher 创建与
 * hydration 收尾两处都调用——创建时机可能早于 record 完全就位（createSessionRecord
 * 事件接线期间），hydration 处补一次兜住该窗口。
 */

export function seedPublisherConfig(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  publisher: ConversationTopicPublisher,
): void {
  const getSeed = this.host.getSessionConfigSeed;
  if (!getSeed) return;
  try {
    const seed = getSeed.call(this.host, sessionId);
    if (seed) publisher.seedConfig(seed);
  } catch (error) {
    this.host.onError?.("v4.configSeed", error);
  }
}

/**
 * 冷恢复 READY 只在明确需要 activation 的入口创建；hydratePublisher 保持 projection-only。
 * 注册 promise 早于 activation，避免 record 提前入册后并发 command/query 越过恢复水位。
 */

export function ensureColdReadyPublisher(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  resumeThoughtLevel?: string,
  workspace?: ZCodeWorkspaceRef,
): Promise<ConversationTopicPublisher> {
  const existingFlight = this.readyFlights.get(sessionId);
  if (existingFlight) return existingFlight;
  // 先登记同一个 READY，再开始所有耗时工作。
  const operation = Promise.resolve().then(async () => {
    const persistedMessages = await this.coldResume.ensureResumed(
      sessionId,
      resumeThoughtLevel,
      workspace,
    );
    return this.hydratePublisher(sessionId, persistedMessages);
  });
  this.readyFlights.set(sessionId, operation);
  // 成功和失败都由同一清理函数释放；不创建会重复传播 rejection 的派生 promise。
  const clear = () => {
    if (this.readyFlights.get(sessionId) === operation) this.readyFlights.delete(sessionId);
  };
  void operation.then(clear, clear);
  return operation;
}

/**
 * 首次订阅时的投影重建（hydration）。语义见 subscribe 注释；
 * synthesized 事件按 sequenceNumber 去重（publisher 已 ingest 过的 live 事件不重放）。
 */

export function hydratePublisher(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  persistedMessages?: MessageWithParts[],
  forceRebuild = false,
): Promise<ConversationTopicPublisher> {
  const existing = this.publishers.get(sessionId);
  // 已 hydrate 过的 live publisher：直接复用（避免重复重建 / 双计）。
  if (existing && this.hydratedSessions.has(sessionId)) return Promise.resolve(existing);

  const inFlight = this.hydrationInFlight.get(sessionId);
  if (inFlight) return inFlight;
  const buffer: HydrationBuffer = {
    cancelled: false,
    eventIds: new Set<string>(),
    rawEvents: [],
  };
  this.hydrationBuffers.set(sessionId, buffer);
  const hydration = this.performHydration(
    sessionId,
    buffer,
    persistedMessages,
    forceRebuild,
  ).finally(() => {
    if (this.hydrationBuffers.get(sessionId) === buffer) {
      this.hydrationBuffers.delete(sessionId);
    }
    if (this.hydrationInFlight.get(sessionId) === hydration) {
      this.hydrationInFlight.delete(sessionId);
    }
  });
  this.hydrationInFlight.set(sessionId, hydration);
  return hydration;
}

export async function seedPublisherUsage(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  publisher: ConversationTopicPublisher,
  persistedMessages?: MessageWithParts[],
  loadedSeed?: SessionUsageSeed | null,
): Promise<void> {
  if (loadedSeed !== undefined) {
    if (loadedSeed) publisher.seedUsage(loadedSeed);
    return;
  }
  const getSeed = this.host.getSessionUsageSeed;
  if (!getSeed) return;
  try {
    const seed = await getSeed.call(this.host, sessionId, persistedMessages);
    if (seed) publisher.seedUsage(seed);
  } catch (error) {
    this.host.onError?.("v4.usageSeed", error);
  }
}

/**
 * 运行中 subagent 没有独立 bootstrap record，但 raw child events 会先建立 publisher。
 * publisher 已存在就代表 conversation live 可订阅，不能再把同一 child cold resume 成
 * 第二个 runtime；真正的历史 session 仍由 host record / persisted resume 负责。
 */

export function hasLiveConversation(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): boolean {
  return this.host.sessionExists(sessionId) || this.detachedLiveSessions.has(sessionId);
}

/** session entry 状态变更后的轻量 metadata 更新，不重放 conversation event。 */

export function updateSharedContextImport(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  source: ConversationSnapshot["sharedContextImport"],
): void {
  const publisher = this.publishers.get(sessionId);
  if (!publisher) return;
  publisher.seedSharedContextImport(source);
  for (const [routeKey, state] of this.flushStates) {
    if (state.sessionId === sessionId) this.scheduleFlush(routeKey, state, publisher);
  }
}
