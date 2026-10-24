import { observeSessionDebug } from "./session-debug.js";
import { type SessionEvent, SessionEventType } from "@zcode/contracts";
import { zcodeProtocolMethods, type ZCodeDeliveryKind } from "@zcode/shared";
import {
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { mapComputerUseOperationEvent } from "./computer-use-operation-event.js";
import {
  type ProtocolStreamingDeltaBatch,
  readStreamingDeltaBatchableEvent,
  mergeProtocolStreamingDeltaBatch,
  shouldFlushProtocolStreamingDeltaBatchForInterval,
  rememberProtocolStreamingDeltaBatchFlush,
  materializeProtocolStreamingDeltaBatch,
} from "./protocol-streaming-batch.js";
import {
  protocolEventSequenceKey,
  shouldHideProtocolSessionEvent,
  mapProtocolSessionEvent,
} from "./protocol-event-sequence.js";
import { logProtocolSessionEventSent } from "./protocol-event-diagnostics.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
interface LiveProtocolStreamingDeltaBatch {
  batch?: ProtocolStreamingDeltaBatch;
  flushedFirstDeltaBatchKeys: Set<string>;
  lastFlushAtByBatchKey: Map<string, number>;
}

const liveProtocolStreamingDeltaBatches = new WeakMap<
  ZCodeProtocolSessionRecord,
  Map<string, LiveProtocolStreamingDeltaBatch>
>();

function getLiveProtocolStreamingDeltaBatchState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): LiveProtocolStreamingDeltaBatch {
  let byDeliveryKind = liveProtocolStreamingDeltaBatches.get(record);
  if (!byDeliveryKind) {
    byDeliveryKind = new Map();
    liveProtocolStreamingDeltaBatches.set(record, byDeliveryKind);
  }
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = byDeliveryKind.get(key);
  if (existing) {
    return existing;
  }
  const created: LiveProtocolStreamingDeltaBatch = {
    flushedFirstDeltaBatchKeys: new Set(),
    lastFlushAtByBatchKey: new Map(),
  };
  byDeliveryKind.set(key, created);
  return created;
}

/**
 * 纯配置事件集合：只改变会话选型（模型/协作模式），不代表用户消息活动。
 * 这些事件不 bump record.updatedAt（= sessions-index lastActivityAt），
 * 避免配置操作驱动侧栏列表按活动时间重排。
 * - ModelSelected / SessionModeChanged：纯配置变更（切模型/切模式）。
 * - FollowupModeChanged：打开会话会自动同步 queue/guide 偏好；这是配置，不应刷新历史活动时间。
 * - SessionTitleUpdated：标题是会话元数据；冷恢复会为了 v4 投影补发标题事件，
 *   不能因此把历史任务当成刚活动过并顶到列表最前。
 * - SessionResumed：打开/恢复会话是读取，不是活动。冷恢复路径刚把
 *   record.updatedAt 回填成 store 的真实时间（见 resumeSession op 内说明），
 *   若再被 resume 事件冲成 Date.now()，点开/刷新任务就会被顶到列表最前并整列重排。
 * - WorkspaceHookAdmissionUpdated：冷恢复重新评估工作区 hook 准入状态，不代表用户活动；
 *   若漏掉黑名单，SessionResumed 后的准入状态事件会把历史任务显示为“刚刚”。
 * - HookRun*：hook lifecycle 是 turn/session 的内部执行细节；正常 turn 已有消息、工具等
 *   活动事件负责更新时间，冷恢复的 SessionStart hook 不能单独制造一次用户活动。
 */
function isNonActivitySessionEvent(event: SessionEvent): boolean {
  return (
    event.type === SessionEventType.ModelSelected ||
    event.type === SessionEventType.SessionModeChanged ||
    event.type === SessionEventType.FollowupModeChanged ||
    event.type === SessionEventType.SessionTitleUpdated ||
    event.type === SessionEventType.SessionResumed ||
    event.type === SessionEventType.WorkspaceHookAdmissionUpdated ||
    event.type === SessionEventType.HookRunStarted ||
    event.type === SessionEventType.HookRunProgress ||
    event.type === SessionEventType.HookRunCompleted ||
    event.type === SessionEventType.HookRunFailed ||
    event.type === SessionEventType.HookRunBlocked
  );
}

/**
 * `record.persistence` 是 runtime「会话已持久化」事实的协议侧镜像：deferred = draft（不进 session/list、
 * 不进 sessions-index、可被 expectedPersistence="deferred" 的条件关闭收回）。首发路径在 accepted 时刻
 * 抢先提升（关闭竞态需要原子判断，见 startPromptTurn / admission），但**任何**经 runtime 首次持久化的
 * 路径都必须让会话离开 draft——中枢直接启动的会话由 runtime 落行、走 controlOnly
 * 启动轮，没有首发，record 一直是 deferred，sessions-index 视其为 draft 而跳过，侧栏永远不出现。
 * 于是在事件流的唯一入口按 runtime 事实对齐一次：持久化之后 runtime 必定至少发一条事件
 * （SessionTitleUpdated first_input），紧随其后的 ingest 便把会话推进 sessions-index。
 * 测试桩的 runtime 可能没有这个方法（`as never`），缺席即不对齐。
 */
function reconcileRecordPersistence(record: ZCodeProtocolSessionRecord): void {
  if (record.persistence !== "deferred") return;
  if (record.app.runtime?.isSessionPersisted?.() === true) record.persistence = "immediate";
}

export function onSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): void {
  const computerUseOperationEvent = mapComputerUseOperationEvent(event);
  if (computerUseOperationEvent) {
    try {
      // 桌面 v4 主链没有旧 session/event 的 deliveryKind 订阅，顶部提示不能继续
      // 依赖该旧门控；这里只发送无内容的生命周期元数据，并与 v4 投影并行、互不阻断。
      context.notify({
        method: zcodeProtocolMethods.computerUseOperationEvent,
        params: computerUseOperationEvent,
      });
      // 这条 notify 过去只在抛错时有日志，成功路径无痕，于是「agent 压根没发」
      // 与「发了但宿主侧静默丢弃」无法区分。CLI 自己的 jsonl 收 debug 级，足够闭环到源头。
      context.logger?.debug("Computer Use operation lifecycle notification sent", {
        event: "zcode_protocol.computer-use.operation-event.sent",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        kind: computerUseOperationEvent.kind,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    } catch (error) {
      context.logger?.warn("Computer Use operation lifecycle notification failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.computer-use.operation-event.failed",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    }
  }
  if (String(event.sessionId) !== record.app.sessionId) {
    // subagent runtime 复用父 runtime 的外部 event sink，但 raw child event
    // 仍属于 child session。无条件用 parent record id ingest 会让 child topic 打开后
    // 不再更新，同时还可能错误 bump 父任务活动时间。这里必须先按事件自己的 sessionId
    // 路由并返回；parent mirror event 本身使用 parent sessionId，继续走下方既有链路。
    context.v4Gateway?.ingestDetachedLiveSession(
      String(event.sessionId),
      event,
      record.app.sessionId,
    );
    return;
  }
  // record.updatedAt 是 sessions-index 的 lastActivityAt 事实源（v4-bridge
  // getSessionIndexMeta），UI 侧栏按它排序。纯配置/恢复/标题元数据事件不是用户会话活动，
  // 之前无差别 bump 会让"切一次模型/点开任务"把任务顶到列表最前并触发整表重排。
  // core 已在发布终态前持久化结果；列表复用同一事实，不从裁剪正文窗口猜测结果。
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    const payload = event.payload as { resultType?: string };
    record.lastOutcome =
      event.type === SessionEventType.TurnError
        ? "error"
        : payload.resultType === "cancelled"
          ? "interrupted"
          : "completed";
  }
  const nonActivityEvent = isNonActivitySessionEvent(event);
  if (event.type === SessionEventType.ModelSelected) {
    // 恢复候选只服务初始 UI；用户新选择生效后不能在后续清空时被旧候选复活。
    delete record.restoredModelSelection;
  }
  if (!nonActivityEvent) {
    record.updatedAt = Date.now();
  }
  reconcileRecordPersistence(record);
  // 调试旁路不依赖聊天订阅；放在 deliveryKind 判断之前，避免旧订阅退出后诊断再次断流。
  observeSessionDebug(record, event);
  // v4 通道：权威事件无条件喂给 v4 投影/发布器——v4 订阅不依赖旧协议的
  // deliveryKind 订阅态，帧节奏由 gateway 按订阅者 profile 自行调度。
  context.v4Gateway?.ingest(record.app.sessionId, event);
  if (!record.deliveryKind) return;
  const deltaInfo = readStreamingDeltaBatchableEvent(event);
  if (deltaInfo && !shouldHideProtocolSessionEvent(record, event)) {
    const batchState = getLiveProtocolStreamingDeltaBatchState(record, record.deliveryKind);
    if (batchState.batch && batchState.batch.batchKey !== deltaInfo.batchKey) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    batchState.batch = mergeProtocolStreamingDeltaBatch(batchState.batch, event, deltaInfo);
    if (
      deltaInfo.shouldFlushFirstDelta &&
      !batchState.flushedFirstDeltaBatchKeys.has(deltaInfo.batchKey)
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
      batchState.flushedFirstDeltaBatchKeys.add(deltaInfo.batchKey);
      return;
    }
    if (
      batchState.batch.delta.length >= batchState.batch.maxChars ||
      shouldFlushProtocolStreamingDeltaBatchForInterval(
        batchState.batch,
        batchState.lastFlushAtByBatchKey,
      )
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    return;
  }

  resetLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
  sendProtocolSessionEvent(context, record, event, record.deliveryKind);
}

function flushLiveProtocolStreamingDeltaBatch(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const batchState = getLiveProtocolStreamingDeltaBatchState(record, deliveryKind);
  if (!batchState.batch) {
    return;
  }
  rememberProtocolStreamingDeltaBatchFlush(batchState.lastFlushAtByBatchKey, batchState.batch);
  const event = materializeProtocolStreamingDeltaBatch(batchState.batch);
  batchState.batch = undefined;
  // 性能修复：provider 会把 Write/Edit input 和 reasoning/text 输出切成大量很小的 delta。
  // 在 protocol 边界按确定性字节预算合并相邻 diff，renderer 仍按 delta 追加，但不再被每个小包唤醒。
  // 文本体感用 SessionEvent.timestamp 做低频 flush，不能用 live setTimeout，否则 replay 无法复现边界。
  sendProtocolSessionEvent(context, record, event, deliveryKind);
}

function resetLiveProtocolStreamingDeltaBatch(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const batchState = getLiveProtocolStreamingDeltaBatchState(record, deliveryKind);
  flushLiveProtocolStreamingDeltaBatch(context, record, deliveryKind);
  batchState.flushedFirstDeltaBatchKeys.clear();
  batchState.lastFlushAtByBatchKey.clear();
}

function sendProtocolSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const mappedEvent = mapProtocolSessionEvent(context, record, event, deliveryKind);
  if (!mappedEvent) return;
  context.notify({
    method: "session/event",
    params: mappedEvent,
  });
  logProtocolSessionEventSent(context, event, mappedEvent);
}
