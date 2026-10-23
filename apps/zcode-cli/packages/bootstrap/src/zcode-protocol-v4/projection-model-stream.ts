// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type { ModelStreamingPayload, SessionEvent } from "@zcode/contracts";

import { SessionEventType } from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）
import { ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS } from "@zcode/shared";

import type {
  AssistantTextRow,
  ConversationDelta,
  ReasoningRow,
} from "@zcode/shared/zcode-protocol-v4";

import { type CanonicalAssistantSegmentFact } from "./event-normalizer.js";

import type { ProductProjectionContext } from "./projection-context.js";
/** 仅供 publisher 的有界增量估算；返回 null 表示必须走候选快照精确校验。 */

export function establishedStreamingAppend(
  this: ProductProjectionContext,
  event: SessionEvent,
): string | null {
  if (event.type !== SessionEventType.ModelStreaming || !this.isRunning()) return null;
  const payload = event.payload as ModelStreamingPayload;
  if (payload.kind === "text_delta" && this.streamingTextRowId !== null) return payload.delta;
  if (payload.kind === "reasoning_delta" && this.streamingReasoningRowId !== null) {
    return payload.delta;
  }
  if (
    payload.kind === "tool_input_delta" &&
    this.toolRowIdByCallId.has(String(payload.toolCallId))
  ) {
    const state = this.fileToolInputPreviewByCallId.get(String(payload.toolCallId));
    if (state) {
      if (
        state.lastPublishedAt !== null &&
        this.ms(event) - state.lastPublishedAt <
          ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
      ) {
        return "";
      }
      // 上界估算必须包含窗口内累计 suffix；只算当前 delta 会低估下一份 wire snapshot。
      return `${state.pendingAppend}${payload.delta}`;
    }
    return payload.delta;
  }
  return null;
}

export function acceptsActiveModelEvent(
  this: ProductProjectionContext,
  event: SessionEvent,
): boolean {
  if (!this.isRunning()) return false;
  // stop/新一轮后旧请求可能迟到；仅凭 session 级状态会让旧 turn 的
  // retry/progress 覆盖当前输入栏。当前 runtime turn 已知时必须按 turnId 隔离。
  return (
    this.currentTurnId === null ||
    event.turnId === undefined ||
    String(event.turnId) === this.currentTurnId
  );
}

export function onModelStreaming(
  this: ProductProjectionContext,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const event = fact.event;
  // 迟到终态不复活：非运行期到达的流式事件一律拒收。
  // assistant 守恒：正文类拒收不是无害丢弃——投影建立晚于
  // TurnStarted（订阅中途建 publisher）时，整段回复会静默消失直到刷新
  // （「回复整段消失」的 live 向量）。计数暴露给 gateway：置 stale 标记，
  // 下次订阅强制重新 hydration 从持久事实补齐。
  if (!this.isRunning()) {
    const dropped = fact.stream;
    if (
      dropped.kind === "text_start" ||
      dropped.kind === "text_delta" ||
      dropped.kind === "reasoning_start" ||
      dropped.kind === "reasoning_delta"
    ) {
      this.droppedContentStreamEventCount += 1;
    }
    return [];
  }
  const payload = fact.stream;
  switch (payload.kind) {
    case "text_start":
      return this.openTextRow(event, fact);
    case "text_delta": {
      const open = this.streamingTextRowId === null ? this.openTextRow(event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: this.streamingTextRowId as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "text_end":
      return this.closeTextRow("complete");
    case "reasoning_start":
      return this.openReasoningRow(event, fact);
    case "reasoning_delta": {
      const open = this.streamingReasoningRowId === null ? this.openReasoningRow(event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: this.streamingReasoningRowId as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "reasoning_end":
      return this.closeReasoningRow();
    case "tool_input_start":
      return this.openToolRow(event, payload, fact.entityId);
    case "tool_input_delta": {
      return this.appendStreamingToolInput(event, payload);
    }
    case "tool_input_end":
      return this.flushStreamingToolInput(String(payload.toolCallId ?? ""));
    case "tool_call":
      return this.finalizeStreamingToolInput(event, payload);
    default:
      return [];
  }
}

export function openTextRow(
  this: ProductProjectionContext,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = this.closeTextRow("complete");
  const continuationRowId = this.outputContinuationTextRowId;
  this.outputContinuationTextRowId = null;
  const continuationRow = continuationRowId === null ? undefined : this.findRow(continuationRowId);
  const currentTurnId = this.turnIdOf(event);
  const lastVisibleRow = this.snapshot.rows.window.at(-1);
  if (
    continuationRow?.kind === "assistantText" &&
    continuationRow.turnId === currentTurnId &&
    lastVisibleRow?.rowId === continuationRow.rowId
  ) {
    // runtime 的 output-token Continue 会为每次 provider 请求创建新的
    // assistantMessageId；旧投影因此把一句话拆成 history partial + 轮尾正文。length
    // 已经在 ModelComplete 上提供精确资格，这里只重新打开紧邻的同 turn text row，
    // 让外部 continuous/replayable 客户端都只观察到一条持续增长的 assistant。
    const {
      actions: _actions,
      assistantResponseId: _assistantResponseId,
      feedback: _feedback,
      ...continuedBase
    } = continuationRow;
    const row: AssistantTextRow = {
      ...continuedBase,
      entityId: fact.entityId,
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      state: "streaming",
    };
    this.streamingTextRowId = row.rowId;
    this.entityIdByRowId.set(row.rowId, fact.entityId);
    const previousMessageId = this.messageIdByRowId.get(row.rowId);
    if (previousMessageId) {
      this.outputContinuationRowIdByMessageId.set(previousMessageId, row.rowId);
    }
    if (fact.transcriptMessageId) {
      this.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
    }
    return [...close, { op: "row.upserted", row }];
  }

  // 不变量：非 output-token Continue 的新段必然新 rowId；已有 streaming 行先收口。
  const row: AssistantTextRow = {
    ...this.rowBase(event, this.turnIdOf(event), fact.entityId),
    kind: "assistantText",
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  this.streamingTextRowId = row.rowId;
  this.entityIdByRowId.set(row.rowId, fact.entityId);
  // forkAssistant 锚点：assistant 行 → 权威 messageId（provider 流首帧即带）。
  if (fact.transcriptMessageId) {
    this.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
  }
  return [...close, { op: "row.appended", row }];
}

export function closeTextRow(
  this: ProductProjectionContext,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  if (this.streamingTextRowId === null) return [];
  const row = this.findRow(this.streamingTextRowId);
  this.streamingTextRowId = null;
  if (row?.kind !== "assistantText") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}

export function openReasoningRow(
  this: ProductProjectionContext,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = this.closeReasoningRow();
  const row: ReasoningRow = {
    ...this.rowBase(event, this.turnIdOf(event), fact.entityId),
    kind: "reasoning",
    // Bug 原因：canonical stream 已携带 assistant response 身份，但旧投影只在正文与工具行
    // 保存它，UI 因而无法把同 response 的 reasoning 确定性归入 CUA Group。
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  this.streamingReasoningRowId = row.rowId;
  this.entityIdByRowId.set(row.rowId, fact.entityId);
  return [...close, { op: "row.appended", row }];
}

export function closeReasoningRow(
  this: ProductProjectionContext,
  state: "complete" | "interrupted" = "complete",
): ConversationDelta[] {
  if (this.streamingReasoningRowId === null) return [];
  const row = this.findRow(this.streamingReasoningRowId);
  this.streamingReasoningRowId = null;
  if (row?.kind !== "reasoning") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}

export function closeStreamingRows(
  this: ProductProjectionContext,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  return [...this.closeTextRow(state), ...this.closeReasoningRow(state)];
}
