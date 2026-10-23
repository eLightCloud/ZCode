// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type {
  ModelNetworkStatusPayload,
  SessionEvent,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
} from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）
import { isHighspeedProviderId } from "@zcode/shared";

import type { ApiRetryState, ConversationDelta } from "@zcode/shared/zcode-protocol-v4";

import {
  modelRetryReasonCode,
  nonNegativeInteger,
  positiveInteger,
  streamRecoveryReasonCode,
} from "./product-projection-model-values.js";

import type { ProductProjectionContext } from "./projection-context.js";
// ── 流式输出 ──

export function onModelNetworkStatus(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this.acceptsActiveModelEvent(event)) return [];
  const payload = event.payload as ModelNetworkStatusPayload;
  if (
    (payload.querySource === undefined || payload.querySource === "main_turn") &&
    (payload.type === "model_request_completed" || payload.type === "model_request_failed") &&
    // 加速卡按 family 拆成了多个隐藏 Provider（zai/bigmodel），不能再和单个常量比较，
    // 否则 BigModel 账号的加速轮会被判成普通轮、节省时间恒为 0。
    isHighspeedProviderId(payload.providerId) &&
    payload.durationMs !== undefined
  ) {
    // Bug 根因：混合 Turn 卡过期后会切到普通 provider，旧逻辑把普通模型的重试/超时
    // 也累计进 Highspeed modelDurationMs，导致节省时间按高速倍率放大数小时。
    const turnId = this.turnIdOf(event);
    this.highspeedModelDurationByTurnId.set(
      turnId,
      (this.highspeedModelDurationByTurnId.get(turnId) ?? 0) + Math.max(0, payload.durationMs),
    );
  }
  switch (payload.type) {
    case "model_retry_scheduled": {
      const attempt = positiveInteger(payload.attempt, 1);
      const maxAttempts = Math.max(positiveInteger(payload.maxAttempts, attempt + 1), attempt + 1);
      return this.setApiRetry({
        attempt,
        maxAttempts,
        nextRetryAt: this.ms(event) + nonNegativeInteger(payload.delayMs, 0),
        reasonCode: modelRetryReasonCode(payload.reason),
      });
    }
    case "model_request_started":
      if (payload.streamRecovery) {
        return this.setApiRetry(
          this.streamRecoveryApiRetry(
            payload.streamRecovery.retryNumber,
            payload.streamRecovery.maxRetries,
            this.ms(event),
            this.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
          ),
        );
      }
      // adapter attempt=2+ 只说明重试请求已发出，不代表连接恢复；
      // 保持当前状态，等首个有效 text/reasoning/tool 进展再清理，避免标签闪退。
      return positiveInteger(payload.attempt, 1) <= 1 ? this.setApiRetry(null) : [];
    case "model_request_completed":
      return this.setApiRetry(null);
    case "model_request_failed":
      return payload.retryable ? [] : this.setApiRetry(null);
    case "model_stream_stalled":
    case "model_first_provider_event":
    case "model_first_content":
    case "model_first_text":
    // 准入等待的两端是 runtime 观测，不是 UI 状态：
    // 不映射成重试/等待标签。
    case "model_request_queued":
    case "model_request_admitted":
    case "model_request_observation":
      return [];
  }
}

export function onStreamRecoveryStarted(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this.acceptsActiveModelEvent(event)) return [];
  const payload = event.payload as StreamRecoveryStartedPayload;
  return this.setApiRetry(
    this.streamRecoveryApiRetry(
      payload.retryNumber,
      payload.maxRetries,
      this.ms(event),
      streamRecoveryReasonCode(payload.failureKind),
    ),
  );
}

export function onStreamRecoveryTailDiscarded(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this.acceptsActiveModelEvent(event)) return [];
  // Bug 原因：Core 已用 tail_discarded 切断失败 assistant attempt，但旧 V4 投影忽略该事件，
  // 下一次 reasoning/text 到达时会把旧行误收口为 complete。这里必须先标 interrupted，
  // 让恢复流用新 assistant identity 打开新行，避免 UI 看起来像一次连续完整输出。
  // Bug 原因：断流时已由 tool_input_start 打开、但还没等到 tool_call 定稿的工具行也属于
  // 被作废的 tail——core 只为已提交的工具合成终态，这些行没人收口；恢复请求会用新的
  // toolCallId 再开一行，UI 于是并排出现两张「正在编写工作流」。已提交（running /
  // pendingApproval）的行不在此列，它们的终态由 executor 自己发布。
  return [
    ...this.closeStreamingRows("interrupted"),
    ...this.closeOpenToolRows(event, "cancelled", (row) => row.status === "inputStreaming"),
  ];
}

export function onStreamRecoveryRetryStarted(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this.acceptsActiveModelEvent(event)) return [];
  const payload = event.payload as StreamRecoveryRetryStartedPayload;
  return this.setApiRetry(
    this.streamRecoveryApiRetry(
      payload.retryNumber,
      payload.maxRetries,
      this.ms(event),
      this.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
    ),
  );
}

export function streamRecoveryApiRetry(
  this: ProductProjectionContext,
  retryNumber: number,
  maxRetriesValue: number,
  nextRetryAt: number,
  reasonCode: string,
): ApiRetryState {
  const attempt = positiveInteger(retryNumber, 1);
  const maxRetries = Math.max(positiveInteger(maxRetriesValue, attempt), attempt);
  return {
    attempt,
    maxAttempts: maxRetries + 1,
    nextRetryAt,
    reasonCode,
  };
}

export function setApiRetry(
  this: ProductProjectionContext,
  apiRetry: ApiRetryState | null,
): ConversationDelta[] {
  const current = this.snapshot.control.apiRetry;
  if (
    current === apiRetry ||
    (current !== null &&
      apiRetry !== null &&
      current.attempt === apiRetry.attempt &&
      current.maxAttempts === apiRetry.maxAttempts &&
      current.nextRetryAt === apiRetry.nextRetryAt &&
      current.reasonCode === apiRetry.reasonCode)
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: this.controlPatch({ apiRetry }),
    },
  ];
}
