import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { SessionsIndexTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { parseSessionsIndexTopic } from "@zcode/shared/zcode-protocol-v4";
import { v4ConversationSubscribeParamsSchema } from "@zcode/shared/zcode-protocol-v4";
import { SessionsIndexPublisher } from "./sessions-index-publisher.js";
import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
import type { V4SubscribeDispatchResult } from "./gateway-support.js";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

/**
 * 把某会话的最新摘要推进到其 workspace 的 sessions-index publisher，并 flush 给列表订阅者。
 * projection 必须在无列表订阅者时也继续推进，保证下一次 snapshot 读取权威当前态；
 * 高频流式增量（ModelStreaming）不触发列表重算，避免抖动（预览在 turn 收口/其他事件时更新）。
 * 旧宿主无 getSessionWorkspaceId → 整体 no-op。
 */

export function fanOutToIndex(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  event: SessionEvent,
): void {
  if (event.type === SessionEventType.ModelStreaming) return;
  // 工作流进度同样是高频流（实测 8s 4000 条），但列表要继续动，所以不是丢弃而是
  // leading + trailing 窗口节流：窗内合并为窗末一帧，终态仍在一个窗口内送达。
  if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
    this.indexFanoutThrottle.request(sessionId);
    return;
  }
  this.publishCurrentSummaryToIndex(sessionId);
}

/**
 * 把当前完整 projection 发布到 sessions-index。
 *
 * fork child 的 resume 会先用少量 live event 建出暂态 draft publisher，
 * 随后的 synthesized hydration 才补齐继承历史。只在 ingest(event) 时 fan-out 的话，
 * hydration 完成后若没有下一条 runtime event，child 就永远停在 draft 基线，
 * task-index syncer 无法观察到 draft→visible，也就不会创建侧栏 task row。
 */

export function publishCurrentSummaryToIndex(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): void {
  // 这一次发布带的就是窗内合并后的当前摘要：待发的 trailing 到此被满足，不重复发帧。
  this.indexFanoutThrottle.notePublished(sessionId);
  const getWorkspaceId = this.host.getSessionWorkspaceId;
  if (!getWorkspaceId) return;
  try {
    const workspaceId = getWorkspaceId.call(this.host, sessionId);
    if (!workspaceId) return;
    if (this.host.isDraftSession?.(sessionId)) return;
    const indexPublisher = this.indexPublishers.get(workspaceId);
    if (!indexPublisher) return;
    const conversationPublisher = this.publishers.get(sessionId);
    if (!conversationPublisher) return;
    const changed = indexPublisher.ingestConversation(
      conversationPublisher.getSnapshot(),
      this.resolveIndexMeta(sessionId),
    );
    if (changed) this.flushIndex(workspaceId);
  } catch (error) {
    this.host.onError?.("v4.sessionsIndex.ingest", error);
  }
}

/** 会话列表元信息（宿主 hook 缺省时的兜底：createdAt=0，lastActivityAt=now）。 */

export function resolveIndexMeta(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): {
  createdAt: number;
  lastActivityAt: number;
  lastOutcome?: SessionSummary["lastOutcome"];
  parentSessionId?: string;
} {
  const meta = this.host.getSessionIndexMeta?.(sessionId);
  return {
    createdAt: meta?.createdAt ?? 0,
    lastActivityAt: meta?.lastActivityAt ?? this.now(),
    ...(meta?.lastOutcome ? { lastOutcome: meta.lastOutcome } : {}),
    ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
  };
}

/** 把某 workspace index publisher 的未发增量帧推给所有列表订阅者。 */

export function flushIndex(
  this: ConversationV4GatewayMethodsContext,
  workspaceId: string,
  onlyConnectionId?: string,
): void {
  const publisher = this.indexPublishers.get(workspaceId);
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
      this.host.onError?.("v4.sessionsIndex.emit", error);
    }
  }
}

/**
 * sessions-index 订阅：订阅某 workspace 的会话列表（与 conversation subscribe 并列，
 * 同一 RPC 方法按 topic 前缀分派）。冷启动：store 摘要种子 + 已加载会话 live 投影覆盖。
 */

export async function subscribeSessionsIndex(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
  const dispatch = await this.subscribeSessionsIndexReserved(rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeSessionsIndexReserved(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const workspaceId = parseSessionsIndexTopic(params.topic);
  if (workspaceId === null) {
    throw new Error(`Not a sessions-index topic: ${params.topic}`);
  }
  const publisher = await this.ensureIndexPublisher(workspaceId, params.legacyTaskIds);
  // ensure 内部可能跨异步 store/claim；dispose 发生在 await 返回前时禁止继续登记订阅。
  this.indexPublishers.ensureActive();
  const result = publisher.subscribeReserved(params.connectionId, params.base);
  try {
    return this.subscribeDispatch(
      {
        subscriptionId: result.subscriptionId,
        mode: result.mode,
        logEpoch: publisher.logEpoch,
      },
      result.reservation,
      () => this.flushIndex(workspaceId),
    );
  } catch (error) {
    // initial logical frame 在 physical encode 阶段即可因 16MiB 上限失败；
    // 已登记订阅/in-flight reservation 后失败必须 rollback，否则会留下永远无法退订的幽灵 owner。
    result.rollback();
    throw error;
  }
}

/** 建/取某 workspace 的 index publisher；建时 store 摘要种子 + live 投影覆盖。 */

export async function ensureIndexPublisher(
  this: ConversationV4GatewayMethodsContext,
  workspaceId: string,
  legacyTaskIds?: readonly string[],
): Promise<SessionsIndexPublisher> {
  const existing = this.indexPublishers.get(workspaceId);
  const shouldRefreshLegacy =
    Boolean(legacyTaskIds?.length) && Boolean(this.host.refreshLegacySessionSummaries);
  if (existing && !shouldRefreshLegacy) return existing;

  return this.indexPublishers.runExclusive(workspaceId, () =>
    this.ensureIndexPublisherExclusive(workspaceId, legacyTaskIds),
  );
}

/** 同 workspace 串行区：可重试 claim/重读与 publisher 构造必须观察同一份最终快照。 */

export async function ensureIndexPublisherExclusive(
  this: ConversationV4GatewayMethodsContext,
  workspaceId: string,
  legacyTaskIds?: readonly string[],
): Promise<SessionsIndexPublisher> {
  const refreshed =
    legacyTaskIds && legacyTaskIds.length > 0
      ? ((await this.host.refreshLegacySessionSummaries?.(workspaceId, legacyTaskIds)) ?? null)
      : null;
  const existing = this.indexPublishers.get(workspaceId);
  if (existing) {
    // claim 不能绑定到首次构造：空种子一旦进 Map 就永久挡住重试。
    // 重读只补缺失项，避免冷存储默认态覆盖已有 live projection。
    if (refreshed && existing.mergeMissingStoredSummaries(refreshed)) {
      this.flushIndex(workspaceId);
    }
    return existing;
  }
  const publisher = new SessionsIndexPublisher(
    workspaceId,
    this.createLogEpoch(`sessions-index/${workspaceId}`),
    this.now,
  );
  // 种子 1：store 里全部会话的轻量摘要（未加载的靠它进列表）。
  const stored = refreshed ?? (await this.host.getStoredSessionSummaries?.(workspaceId)) ?? [];
  for (const summary of stored) publisher.seed(summary);
  // 种子 2：已加载会话用 live 投影覆盖（更准的 phase/preview/backgroundWork）。
  const liveIds = this.host.listWorkspaceSessionIds?.(workspaceId) ?? [...this.publishers.keys()];
  for (const sessionId of liveIds) {
    const conversationPublisher = this.publishers.get(sessionId);
    if (!conversationPublisher) continue;
    // draft（deferred 未发首条）不进冷启动种子，与 fanOutToIndex 的过滤一致。
    if (this.host.isDraftSession?.(sessionId)) continue;
    publisher.ingestConversation(
      conversationPublisher.getSnapshot(),
      this.resolveIndexMeta(sessionId),
    );
  }
  this.indexPublishers.set(workspaceId, publisher);
  return publisher;
}
