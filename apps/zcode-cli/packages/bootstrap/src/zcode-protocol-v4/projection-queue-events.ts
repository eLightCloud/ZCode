// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type {
  SessionEvent,
  TurnInputIntentMetadata,
  TurnSteerDeliveryChangedPayload,
  TurnSteerDispatchChangedPayload,
  TurnSteerDrainedPayload,
  TurnSteerQueuedPayload,
} from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）

import type { ConversationDelta, QueueItem } from "@zcode/shared/zcode-protocol-v4";

import type { ProductProjectionContext } from "./projection-context.js";
// ── turn-steer 队列──

export function onTurnSteerQueued(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerQueuedPayload;
  const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
  const existingIndex = this.snapshot.queue.items.findIndex(
    (item) => item.queueItemId === queueItemId,
  );
  const existing = existingIndex >= 0 ? this.snapshot.queue.items[existingIndex] : undefined;
  // queued 事件的 admittedDelivery 只能是 queue/guide。若读到早期或损坏事件里的
  // startNow，必须以实际 queue delivery 为准，不能让投影声称输入已立即启动。
  const admittedDelivery: "queue" | "guide" =
    payload.intent?.admittedDelivery === "queue" || payload.intent?.admittedDelivery === "guide"
      ? payload.intent.admittedDelivery
      : (payload.delivery ??
        (existing?.delivery.admitted === "queue" || existing?.delivery.admitted === "guide"
          ? existing.delivery.admitted
          : this.snapshot.config.followupMode === "guide"
            ? "guide"
            : "queue"));
  const requestedDelivery =
    payload.intent?.requestedDelivery ?? existing?.delivery.requested ?? admittedDelivery;
  const fallbackReasonCode =
    payload.intent?.fallbackReasonCode ?? existing?.delivery.fallbackReasonCode;
  // Bug 根因：队列投影曾漏掉 intent.highspeed，自动和手动提升都因此把有效卡误判为不存在。
  const highspeed = payload.intent?.highspeed ?? existing?.highspeed;
  const nextItem: QueueItem = {
    queueItemId,
    kind:
      payload.intent?.kind === "compact" || payload.commandKind === "compact"
        ? ("compact" as const)
        : payload.intent?.kind === "sendGoalCommand" || payload.commandKind === "sendGoalCommand"
          ? ("sendGoalCommand" as const)
          : (existing?.kind ?? ("sendText" as const)),
    text: payload.input,
    sourceCommandId:
      payload.intent?.sourceCommandId ??
      existing?.sourceCommandId ??
      payload.inputId ??
      payload.pendingInputId,
    clientId: payload.intent?.clientId ?? existing?.clientId ?? "cli",
    attachments: payload.intent?.attachmentRefs ?? existing?.attachments ?? [],
    ...((payload.intent?.source ?? existing?.source)
      ? { source: payload.intent?.source ?? existing?.source }
      : {}),
    // QueueItem 同时是提升执行的输入，不只是 UI 展示；漏字段会让新 Turn 沿用旧权限／模型。
    // 旧的正文编辑事件可能没有 intent，只能保留同项原事实，不能读取当前 Session 补值。
    modelSelection: payload.intent?.modelSelection ?? existing?.modelSelection,
    mode: payload.intent?.mode ?? existing?.mode,
    planEnabled: payload.intent?.planEnabled ?? existing?.planEnabled,
    sharedContextRefs: payload.intent?.sharedContextRefs ?? existing?.sharedContextRefs,
    provenance: payload.intent?.provenance ?? existing?.provenance,
    // 排队事件和原地编辑都必须保留可信接入来源，不能在 UI 投影时丢掉发送者。
    ...((payload.intent?.inputOrigin ?? existing?.inputOrigin)
      ? { inputOrigin: payload.intent?.inputOrigin ?? existing?.inputOrigin }
      : {}),
    ...((payload.intent?.conversationQuotes ?? existing?.conversationQuotes)
      ? { conversationQuotes: payload.intent?.conversationQuotes ?? existing?.conversationQuotes }
      : {}),
    ...((payload.intent?.botGroupSource ?? existing?.botGroupSource)
      ? { botGroupSource: payload.intent?.botGroupSource ?? existing?.botGroupSource }
      : {}),
    delivery: {
      requested: requestedDelivery,
      admitted: admittedDelivery,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
    order: {
      admissionSeq:
        payload.intent?.admissionSeq ?? existing?.order.admissionSeq ?? event.sequenceNumber,
      queuePosition:
        payload.intent?.queuePosition ??
        existing?.order.queuePosition ??
        Math.max(0, (payload.queueLength ?? 1) - 1),
    },
    steer:
      !payload.intent && !payload.delivery && existing
        ? existing.steer
        : fallbackReasonCode
          ? { state: "fellBack", reasonCode: fallbackReasonCode }
          : admittedDelivery === "guide"
            ? { state: "steering" }
            : { state: "notRequested" },
    dispatch: { state: "queued" },
    ...(highspeed ? { highspeed } : {}),
    ...(payload.toolDisallowlist ? { toolDisallowlist: [...payload.toolDisallowlist] } : {}),
    admittedAt: payload.intent?.admittedAt ?? existing?.admittedAt ?? this.ms(event),
  };
  // 投递语义侧表：payload 未带（旧 runtime 事件）时按当前 followupMode 兜底。
  this.deliveryByPendingInputId.set(payload.pendingInputId, admittedDelivery);
  // 同 id 重入 = editQueueItem 原地更新（保位）；新 id = 追加。旧逻辑 filter+append
  // 会把编辑项移到队尾，破坏 queueContentIndependence 的位置语义。
  const items =
    existingIndex >= 0
      ? this.snapshot.queue.items.map((item, index) => (index === existingIndex ? nextItem : item))
      : [...this.snapshot.queue.items, nextItem];
  return [
    {
      op: "state.updated",
      patch: this.queuePatch({ ...this.snapshot.queue, items }),
    },
  ];
}

export function onTurnSteerDispatchChanged(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDispatchChangedPayload;
  if (
    !this.snapshot.queue.items.some((candidate) => candidate.queueItemId === payload.pendingInputId)
  ) {
    return [];
  }
  const dispatch =
    payload.state === "queued"
      ? ({ state: "queued" } as const)
      : ({
          state: payload.state,
          reservationId: payload.reservationId,
        } as const);
  return [
    {
      op: "state.updated",
      patch: this.queuePatch({
        ...this.snapshot.queue,
        items: this.snapshot.queue.items.map((candidate) =>
          candidate.queueItemId === payload.pendingInputId ? { ...candidate, dispatch } : candidate,
        ),
      }),
    },
  ];
}

export function onTurnSteerDeliveryChanged(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDeliveryChangedPayload;
  const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
  if (!this.snapshot.queue.items.some((item) => item.queueItemId === queueItemId)) {
    return [];
  }
  this.deliveryByPendingInputId.set(payload.pendingInputId, payload.admittedDelivery);
  return [
    {
      op: "state.updated",
      patch: this.queuePatch({
        ...this.snapshot.queue,
        items: this.snapshot.queue.items.map((item) =>
          item.queueItemId === queueItemId
            ? {
                ...item,
                delivery: {
                  requested: payload.requestedDelivery,
                  admitted: payload.admittedDelivery,
                  fallbackReasonCode: payload.fallbackReasonCode,
                },
                steer: {
                  state: "fellBack",
                  reasonCode: payload.fallbackReasonCode,
                },
              }
            : item,
        ),
      }),
    },
  ];
}

export function onTurnSteerDrained(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDrainedPayload;
  const runtimeTurnId = String(
    payload.targetTurnId ?? event.turnId ?? this.currentTurnId ?? "turn-unknown",
  );
  // drain 事实优先自带文本/messageId（drainedInputs），
  // 投影不再依赖内存 queue 状态取文本——旧实现查不到 queue item 就静默 continue，
  // 用户输入从 queue 消失后也不进 history。旧事件（无 drainedInputs）回退查表。
  const items =
    payload.drainedInputs ??
    payload.pendingInputIds.flatMap((pendingInputId, index) => {
      const queueItem = this.snapshot.queue.items.find(
        (candidate) => candidate.queueItemId === pendingInputId,
      );
      if (!queueItem) return [];
      const intent: TurnInputIntentMetadata = {
        sourceCommandId: queueItem.sourceCommandId,
        queueItemId: queueItem.queueItemId,
        clientId: queueItem.clientId,
        kind: queueItem.kind,
        text: queueItem.text,
        ...(queueItem.modelSelection ? { modelSelection: queueItem.modelSelection } : {}),
        ...(queueItem.mode ? { mode: queueItem.mode } : {}),
        ...(queueItem.planEnabled !== undefined ? { planEnabled: queueItem.planEnabled } : {}),
        admissionSeq: queueItem.order.admissionSeq,
        admittedAt: queueItem.admittedAt,
        requestedDelivery: queueItem.delivery.requested,
        admittedDelivery: queueItem.delivery.admitted,
        queuePosition: queueItem.order.queuePosition,
        ...(queueItem.delivery.fallbackReasonCode
          ? { fallbackReasonCode: queueItem.delivery.fallbackReasonCode }
          : {}),
        attachmentRefs: queueItem.attachments,
      };
      return [
        {
          pendingInputId,
          messageId: payload.injectedMessageIds?.[index],
          text: queueItem.text,
          delivery: this.deliveryByPendingInputId.get(pendingInputId),
          intent,
        },
      ];
    });

  const deltas: ConversationDelta[] = [];
  for (const item of items) {
    const delivery =
      item.delivery ?? this.deliveryByPendingInputId.get(item.pendingInputId) ?? "queue";
    // queue 消费 = product turn 边界（每条一轮：收口上一段
    // header、开新 turnHeader、后续 assistant 归新轮）；guide steer 内联当前轮。
    if (delivery === "queue") {
      deltas.push(
        ...this.splitProductTurn(
          event,
          runtimeTurnId,
          item.messageId ? String(item.messageId) : undefined,
        ),
      );
    }
    const messageId = item.messageId ? String(item.messageId) : null;
    const entityId = messageId ?? item.pendingInputId;
    const productTurnId = this.turnIdOf(event);
    const rootSourceCommandId =
      item.intent?.provenance?.sourceCommandId ?? item.intent?.sourceCommandId;
    const row = {
      ...this.rowBase(event, productTurnId, entityId),
      kind: "userInput" as const,
      text:
        item.intent?.conversationQuotes || item.intent?.botGroupSource
          ? (item.intent.text ?? item.text)
          : item.text,
      origin: "realUser" as const,
      ...(delivery === "guide" ? { guided: true as const } : {}),
      ...(item.intent?.sourceCommandId ? { sourceCommandId: item.intent.sourceCommandId } : {}),
      ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
      ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
      ...(item.intent?.conversationQuotes
        ? { conversationQuotes: item.intent.conversationQuotes }
        : {}),
      ...(item.intent?.botGroupSource ? { botGroupSource: item.intent.botGroupSource } : {}),
      ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
      ...(item.intent?.highspeed ? { highspeed: item.intent.highspeed } : {}),
      ...(item.intent?.attachmentRefs?.length ? { attachments: item.intent.attachmentRefs } : {}),
      ...(item.intent?.source ? { source: item.intent.source } : {}),
    };
    // queue/guide 消费后的 real-user row 与普通 TurnStarted 共用完整 canonical target；
    // 缺 messageId 的旧事件仍只可展示，不暴露无法执行的 edit action。
    this.registerCanonicalUserRowTarget(
      row.rowId,
      entityId,
      messageId && item.intent?.kind !== "compact"
        ? {
            entityId,
            productTurnId,
            transcriptMessageId: messageId,
            coveredByStableCompact: false,
            intent: {
              kind: item.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
              text: item.intent?.text ?? item.text,
              ...(item.intent?.sourceCommandId
                ? { sourceCommandId: item.intent.sourceCommandId }
                : {}),
              ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
              ...(item.intent?.conversationQuotes
                ? { conversationQuotes: item.intent.conversationQuotes }
                : {}),
              ...(item.intent?.botGroupSource
                ? { botGroupSource: item.intent.botGroupSource }
                : {}),
              ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
              ...(item.intent?.attachmentRefs ? { attachments: item.intent.attachmentRefs } : {}),
              ...(item.intent?.queueItemId ? { queueItemId: item.intent.queueItemId } : {}),
              ...(item.intent?.admissionSeq !== undefined
                ? { admissionSeq: item.intent.admissionSeq }
                : {}),
              ...(item.intent?.admittedAt !== undefined
                ? { admittedAt: item.intent.admittedAt }
                : {}),
              ...(item.intent?.requestedDelivery
                ? { requestedDelivery: item.intent.requestedDelivery }
                : {}),
              ...(item.intent?.admittedDelivery
                ? { admittedDelivery: item.intent.admittedDelivery }
                : {}),
              ...(item.intent?.fallbackReasonCode
                ? { fallbackReasonCode: item.intent.fallbackReasonCode }
                : {}),
              ...(item.intent?.modelSelection
                ? { modelSelection: item.intent.modelSelection }
                : {}),
              ...(item.intent?.mode ? { mode: item.intent.mode } : {}),
              ...(item.intent?.planEnabled !== undefined
                ? { planEnabled: item.intent.planEnabled }
                : {}),
              ...(item.intent?.provenance ? { provenance: item.intent.provenance } : {}),
            },
          }
        : undefined,
    );
    if (delivery === "guide") {
      deltas.push(...this.openGuidedWorkSegment(event, row.entityId ?? item.pendingInputId));
    }
    deltas.push({ op: "row.appended", row });
    this.deliveryByPendingInputId.delete(item.pendingInputId);
  }
  return [...deltas, ...this.removeQueueItems(payload.pendingInputIds)];
}
