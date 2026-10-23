// Transcript → SessionEvent 合成（「reduce(transcript) ≡ reduce(events)」）。
//
// 动机：v4 投影是事件溯源，但部分历史突变（纯对话 fork 复制 message 不复制 event、
// rewind 截断只动 message 库）会让 session 的事件日志无法覆盖可见 transcript。冷订阅
// hydration 从事件日志重建拿不到这些历史（「fork-child 历史」）。
//
// 本模块把 message 库的 transcript 反向合成为 reducer 能消费的 SessionEvent 序列——
// 从而复用整套 ProductProjection 归约逻辑，不必再写一份 message→row 的平行归约器。
// 合成事件是「视图重建」用途：只需产出与真实事件流「归约等价」的最小序列。
// v4 冷恢复只能重放 ProductProjection 认识的事件；如果 transcript 里的
// tool/reasoning/subagent/compact part 不反向合成，重启后历史可见运行态会从快照里消失。
import type { AssistantErrorInfo, MessageWithParts } from "@zcode/contracts";

import { STREAM_RECOVERY_DISCARDED_ERROR_NAME } from "@zcode/contracts";

import { errorAttributionSchema, type ErrorAttribution } from "@zcode/shared/zcode-protocol-v4";

import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";

import {
  LEGACY_MODEL_REQUEST_CANCELLED_MESSAGE,
  LEGACY_PROTOCOL_SESSION_STOPPED_MESSAGE,
  PERSISTED_CANCELLATION_CODES,
} from "./transcript-hydration-contract.js";

import type { TurnResultForHydration } from "./transcript-hydration-contract.js";

export function normalizeTurnResult(
  current: TurnResultForHydration,
  next: TurnResultForHydration,
): TurnResultForHydration {
  if (current === "cancelled" || next === "cancelled") {
    return "cancelled";
  }
  if (current === "error_during_execution" || next === "error_during_execution") {
    return "error_during_execution";
  }
  return "success";
}

export function assistantErrorData(error: AssistantErrorInfo): Record<string, unknown> | undefined {
  return error.data && typeof error.data === "object" && !Array.isArray(error.data)
    ? error.data
    : undefined;
}

export function persistedErrorAttribution(
  data: Record<string, unknown> | undefined,
): ErrorAttribution | undefined {
  const parsed = errorAttributionSchema.safeParse(data?.attribution);
  return parsed.success ? parsed.data : undefined;
}

export function isPersistedAssistantCancellation(error: AssistantErrorInfo): boolean {
  const data = assistantErrorData(error);
  const code = typeof data?.code === "string" ? data.code : undefined;
  if (
    data?.turnResult === "cancelled" ||
    data?.resultType === "cancelled" ||
    (code !== undefined && PERSISTED_CANCELLATION_CODES.has(code)) ||
    error.name === "AbortError"
  ) {
    return true;
  }

  if (
    code === undefined &&
    error.name === "Error" &&
    data?.message === LEGACY_PROTOCOL_SESSION_STOPPED_MESSAGE
  ) {
    // 旧 session/stop 使用普通 Error 作为 AbortSignal.reason，transcript 又未持久化
    // cancelled result；冷恢复若只认 AbortError，会把用户停止重新合成为 TurnError 和错误 Banner。
    return true;
  }

  // 旧 transcript 的 AiSdkModelAdapterError 没有持久化 model error code，
  // 只能用 ZCode 自身生成的标准 name/message 二元组兼容恢复；不泛化匹配 provider 文案。
  return (
    code === undefined &&
    error.name === "AiSdkModelAdapterError" &&
    data?.message === LEGACY_MODEL_REQUEST_CANCELLED_MESSAGE
  );
}

/**
 * stream recovery 把作废的半截 assistant 持久化成带 error 的消息，随后从锚点
 * 重发并正常完成；live 投影只把它收口为 interrupted 行，不产生 TurnError。旧冷恢复却把
 * 任何带 error 的 assistant 都当本轮失败，重开会话后凭空弹出「Partial assistant output
 * was discarded」的错误 Banner。这个标记只服务压缩/fork 边界隔离，对本轮结果必须透明。
 */
export function isPersistedStreamRecoveryDiscard(error: AssistantErrorInfo): boolean {
  return error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME;
}

// preface 轮开轮门槛：只含 model_change/session_fork 宿主等不可渲染内容的 assistant
// 消息不开轮，避免合成出只有「已工作」壳的空轮。
export function assistantMessageHasSynthesizableContent(message: MessageWithParts): boolean {
  return message.parts.some((part) => {
    switch (part.type) {
      case "text":
        return part.ignored !== true && part.text.length > 0;
      case "reasoning":
        return part.text.length > 0;
      case "tool":
        return !shouldHideInvalidToolCallFromProduct(part.tool, part.metadata);
      case "subtask":
      case "compaction":
        return true;
      case "timeline":
        return (
          part.timelineType === "context_compaction" || part.timelineType === "goal_verification"
        );
      default:
        return false;
    }
  });
}
