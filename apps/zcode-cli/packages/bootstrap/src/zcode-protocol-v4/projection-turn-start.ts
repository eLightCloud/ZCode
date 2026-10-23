// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）
import {
  parseZCodeBackgroundTaskNotificationText,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
} from "@zcode/shared";

import type {
  ConversationDelta,
  ConversationRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";

import { type CanonicalUserIntentFact } from "./event-normalizer.js";

import { buildToolOutput } from "./projection-rows.js";

import type { ProductProjectionContext } from "./projection-context.js";
export function onTurnStarted(
  this: ProductProjectionContext,
  fact: CanonicalUserIntentFact,
): ConversationDelta[] {
  const event = fact.event;
  const runtimeTurnId = fact.runtimeTurnId;
  const turnId = fact.productTurnId;
  this.currentTurnId = runtimeTurnId;
  this.currentTurnStartedModelOnly = fact.visibility === "modelOnly";
  // 新 runtimeTurn：product turn 映射归零（1:1），工时基准 = 本轮起点。
  this.productTurnIdByRuntimeTurnId.delete(runtimeTurnId);
  if (turnId !== runtimeTurnId) this.productTurnIdByRuntimeTurnId.set(runtimeTurnId, turnId);
  this.runtimeTurnIdByProductTurnId.set(turnId, runtimeTurnId);
  this.productTurnSplitOrdinalByRuntimeTurnId.delete(runtimeTurnId);
  this.currentProductTurnStartedAtMs = this.ms(event);
  this.streamingTextRowId = null;
  this.streamingReasoningRowId = null;
  this.outputContinuationTextRowId = null;

  // background Agent 的 ToolCallResult 只是 launch ACK，先把工具行收口成
  // success；子 Agent 的真实终态随后只作为 model-only task-notification 开新轮。
  // V4 过去没有按 tool-use-id 消费这条权威事实，因此 429 后卡片会永久停在 completed。
  const deltas: ConversationDelta[] = this.applyBackgroundTaskNotification(fact);
  const sharedContextRef = fact.sharedContextRefs?.[0];
  if (
    sharedContextRef &&
    this.snapshot.sharedContextImport &&
    "contextId" in this.snapshot.sharedContextImport &&
    this.snapshot.sharedContextImport.contextId === sharedContextRef.context_id &&
    (this.snapshot.sharedContextImport.status === "pending" ||
      this.snapshot.sharedContextImport.status === "reserved")
  ) {
    const sharedContextImport = {
      ...this.snapshot.sharedContextImport,
      status: "attached" as const,
    };
    this.snapshot = { ...this.snapshot, sharedContextImport };
    deltas.push({ op: "state.updated", patch: { sharedContextImport } });
  }
  // marker 时机：只有当
  // 本轮实际使用的 provider/model 身份与上一轮不同时，才在 turnHeader 之前落
  // modelChange marker。普通首轮 silentInitial 不产 marker；显式 sourceLess 边界
  // 生成“正在使用”marker。思考深度变化只更新 config.thought，不是模型身份变化。
  // Bug 背景：旧实现在 onModelSelected（切换动作时）即落 marker，草稿态预热会话
  // 切一次模型就会在首条消息上方挂出 [modelChange]。
  const config = this.snapshot.config;
  const hasModel = config.provider !== "" && config.model !== "";
  if (hasModel && this.lastTurnModel.kind === "sourceLess") {
    deltas.push({
      op: "row.appended",
      row: {
        ...this.rowBase(
          event,
          turnId,
          `model-initial:${turnId}:${config.provider}/${config.model}`,
        ),
        kind: "timelineMarker",
        lane: "lightBoundary",
        marker: {
          type: "modelChange",
          toProvider: config.provider,
          toModel: config.model,
          toThought: config.thought,
        },
      },
    });
  } else if (
    hasModel &&
    this.lastTurnModel.kind === "known" &&
    (this.lastTurnModel.provider !== config.provider || this.lastTurnModel.model !== config.model)
  ) {
    deltas.push({
      op: "row.appended",
      row: {
        ...this.rowBase(
          event,
          turnId,
          `model-change:${turnId}:${this.lastTurnModel.provider}/${this.lastTurnModel.model}->${config.provider}/${config.model}`,
        ),
        kind: "timelineMarker",
        // lane 由投影裁决（UI 不得按 marker type 自行推断落位语义）。
        lane: "lightBoundary",
        marker: {
          type: "modelChange",
          fromProvider: this.lastTurnModel.provider,
          fromModel: this.lastTurnModel.model,
          toProvider: config.provider,
          toModel: config.model,
          toThought: config.thought,
        },
      },
    });
  }
  if (hasModel) {
    this.lastTurnModel = {
      kind: "known",
      provider: config.provider,
      model: config.model,
      thought: config.thought,
    };
  }
  const headerBase = this.rowBase(event, turnId, turnId);
  const header: TurnHeaderRow = {
    ...headerBase,
    kind: "turnHeader",
    origin: fact.turnHeaderOrigin,
    executionKind: fact.executionKind,
    ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
    ...(fact.originMeta ? { originMeta: fact.originMeta } : {}),
    ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
    state: "running",
    startedAt: headerBase.createdAt,
  };
  this.turnHeaderRowIdByTurnId.set(turnId, header.rowId);
  deltas.push({ op: "row.appended", row: header });

  // model-only 输入（goal continuation 等）不产生可见 userInput row。
  if (fact.visibility === "visible") {
    const rowBase = this.rowBase(event, turnId, fact.entityId);
    const rootSourceCommandId = fact.provenance?.sourceCommandId ?? fact.sourceCommandId;
    const attachments = fact.attachments?.map((attachment, index) => ({
      ...attachment,
      ref: attachment.ref ?? `turn-attachment/${rowBase.rowId}/${index}`,
    }));
    const row: UserInputRow = {
      ...rowBase,
      kind: "userInput",
      text:
        fact.conversationQuotes || fact.botGroupSource
          ? (fact.intentText ?? fact.input)
          : fact.input,
      origin: fact.origin,
      ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
      ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
      ...(fact.inputOrigin ? { inputOrigin: fact.inputOrigin } : {}),
      ...(fact.conversationQuotes ? { conversationQuotes: fact.conversationQuotes } : {}),
      ...(fact.botGroupSource ? { botGroupSource: fact.botGroupSource } : {}),
      ...(fact.clientId ? { clientId: fact.clientId } : {}),
      ...(fact.highspeed ? { highspeed: fact.highspeed } : {}),
      ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
      ...(fact.epilogueStart === undefined ? {} : { epilogueStart: fact.epilogueStart }),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(fact.source ? { source: fact.source } : {}),
    };
    // workspace checkpoint 以 user messageId 为 targetMessageId。
    // 普通 TurnStarted 也要登记 userInput row 的内部锚点，否则文件摘要 query
    // 只能找到 assistant messageId，展开列表会查不到该轮 checkpoint。
    this.registerCanonicalUserRowTarget(
      row.rowId,
      fact.entityId,
      fact.transcriptMessageId
        ? {
            entityId: fact.entityId,
            productTurnId: fact.productTurnId,
            transcriptMessageId: fact.transcriptMessageId,
            coveredByStableCompact: false,
            intent: {
              kind: fact.intentKind,
              text: fact.intentText,
              ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
              ...(fact.inputOrigin ? { inputOrigin: fact.inputOrigin } : {}),
              ...(fact.conversationQuotes ? { conversationQuotes: fact.conversationQuotes } : {}),
              ...(fact.botGroupSource ? { botGroupSource: fact.botGroupSource } : {}),
              ...(fact.clientId ? { clientId: fact.clientId } : {}),
              ...(fact.attachments ? { attachments: fact.attachments } : {}),
              ...(fact.queueItemId ? { queueItemId: fact.queueItemId } : {}),
              ...(fact.admissionSeq !== undefined ? { admissionSeq: fact.admissionSeq } : {}),
              ...(fact.admittedAt !== undefined ? { admittedAt: fact.admittedAt } : {}),
              ...(fact.requestedDelivery ? { requestedDelivery: fact.requestedDelivery } : {}),
              ...(fact.admittedDelivery ? { admittedDelivery: fact.admittedDelivery } : {}),
              ...(fact.fallbackReasonCode ? { fallbackReasonCode: fact.fallbackReasonCode } : {}),
              ...(fact.modelSelection ? { modelSelection: fact.modelSelection } : {}),
              ...(fact.mode ? { mode: fact.mode } : {}),
              ...(fact.planEnabled !== undefined ? { planEnabled: fact.planEnabled } : {}),
              ...(fact.provenance ? { provenance: fact.provenance } : {}),
            },
          }
        : undefined,
    );
    deltas.push({
      op: "row.appended",
      row,
    });
  }

  if (fact.executionKind === "agent") {
    deltas.push({
      op: "state.updated",
      patch: this.controlPatch({
        phase: "running",
        sessionEnded: false,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "assistant",
        activeWorks: [
          {
            kind: fact.origin === "goalContinuation" ? "goalContinuation" : "primaryTurn",
            ...(fact.foregroundExecutionId
              ? { foregroundExecutionId: fact.foregroundExecutionId }
              : {}),
            // 自动中断必须关联实际执行输入，不能由客户端按最后一条消息猜测。
            ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
            startedAt: this.ms(event),
          },
        ],
        // 新一轮被接受后，旧错误不再是当前事实（与旧 reducer 同一裁决）。
        lastError: null,
        apiRetry: null,
      }),
    });
  }
  // /goal 的可见 query 用 controlOnly turn 建立 live 时间线身份，
  // 但真实执行属于紧随其后的 goalContinuation。若控制轮也推进 running，连续链路
  // 会短暂生成第二份 activeWorks，恢复投影也会出现伪造的工作生命周期。
  return deltas;
}

export function applyBackgroundTaskNotification(
  this: ProductProjectionContext,
  fact: CanonicalUserIntentFact,
): ConversationDelta[] {
  const parsed = parseZCodeBackgroundTaskNotificationText(fact.input);
  if (!parsed) return [];
  const row = this.findToolRow(parsed.toolUseId);
  if (!row) return [];

  const notificationStatus = zcodeBackgroundTaskNotificationToolUpdateStatus(
    parsed.notification.status,
  );
  const status: ToolCallRow["status"] =
    notificationStatus === "failed"
      ? "error"
      : notificationStatus === "stopped"
        ? "cancelled"
        : "success";
  const content =
    parsed.notification.result ?? parsed.notification.summary ?? parsed.notification.error;
  const next: ToolCallRow = {
    ...row,
    status,
    ...(content
      ? {
          output: buildToolOutput({ success: status === "success", content }, parsed.toolUseId),
        }
      : {}),
    endedAt: this.ms(fact.event),
  };
  if (status === "error") {
    next.error = {
      code: "fault.runtime.backgroundTaskFailed",
      message: parsed.notification.error ?? content ?? "Background task failed.",
    };
  } else {
    delete next.error;
  }
  return [{ op: "row.upserted", row: next }];
}

/** messageId → rowId 反查（messageIdByRowId 的逆向线性扫描；行数有界，无需额外索引）。 */

export function rowIdForMessageId(
  this: ProductProjectionContext,
  messageId: string,
): number | null {
  const continuationRowId = this.outputContinuationRowIdByMessageId.get(messageId);
  if (continuationRowId !== undefined) return continuationRowId;
  for (const [rowId, mid] of this.messageIdByRowId) {
    if (mid === messageId) return rowId;
  }
  return null;
}

export function rewindAnchorForRows(
  this: ProductProjectionContext,
  rows: readonly ConversationRow[],
  rowId: number,
): string | null {
  const row = rows.find((candidate) => candidate.rowId === rowId);
  if (!row) return null;
  const turnId = row.turnId;
  for (const [candidateRowId, messageId] of this.messageIdByRowId) {
    const candidate = rows.find((item) => item.rowId === candidateRowId);
    if (candidate && candidate.turnId === turnId) return messageId;
  }
  return null;
}
