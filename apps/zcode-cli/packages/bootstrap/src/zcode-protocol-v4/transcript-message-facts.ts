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
import type { MessagePart, MessageWithParts } from "@zcode/contracts";

import { getConversationMessageProjectionPolicy } from "@zcode/shared";

export {
  backgroundResultOriginMetaOfMessage,
  epilogueStartOfMessage,
  executionKindOfMessage,
  inputIntentOfMessage,
  isLegacyCompactMaintenanceInput,
  isRealUserTurnStarter,
  isTurnBoundaryStarter,
  parseWorkflowNotificationMeta,
  steerDeliveryOfMessage,
  textOfMessage,
  workflowLaunchOfMessage,
} from "./transcript-input-intent.js";

export {
  finiteTimeMs,
  intervalEndOrStartMs,
  messageCreatedAtMs,
  messageEndAtMs,
  partEndAtMs,
} from "./transcript-message-timing.js";

export {
  assistantErrorData,
  assistantMessageHasSynthesizableContent,
  isPersistedAssistantCancellation,
  isPersistedStreamRecoveryDiscard,
  normalizeTurnResult,
  persistedErrorAttribution,
} from "./transcript-message-outcome.js";

export { parseJsonObject, stringField } from "./transcript-metadata-fields.js";

export {
  agentIdFromToolOutput,
  contentBlocksToText,
  subagentInfoFromToolPart,
  subagentStatusFromToolPart,
} from "./transcript-subagent-facts.js";

export {
  forkContextFromMetadata,
  forkContextOfMessage,
  isForkTimelineMessage,
} from "./transcript-fork-facts.js";

export {
  assistantModelSelectionOf,
  hydratedModelKey,
  modelChangeKeyOfPart,
  modelChangeToModelOf,
  sessionModelSelectionOfHydratedMessage,
  turnModelSelectionOfUserMessage,
} from "./transcript-model-facts.js";

export function isProviderContextOnlyAssistant(message: MessageWithParts): boolean {
  return (
    message.info.role === "assistant" &&
    getConversationMessageProjectionPolicy(message) === "providerContextOnly"
  );
}

export function stableToolSchedule(toolCallId: string) {
  return {
    executionOrder: [toolCallId],
    parallelGroups: [[toolCallId]],
  };
}

/**
 * 附件渲染：FilePart → TurnStarted 附件展示元信息（TurnAttachmentMeta）。
 * 冷订阅/fork-child 的历史附件由 transcript 反向合成——与 live 事件同一投影入口
 * （buildUserInputRow），保证冷/热路径行内容一致。
 */
export function attachmentMetasOfMessage(
  parts: readonly MessagePart[],
): Array<{ fileName: string; mime: string; bytes: number; ref?: string }> {
  const fileParts = parts.filter(
    (part): part is Extract<MessagePart, { type: "file" }> => part.type === "file",
  );
  return fileParts.map((part, index) => {
    const urlIsStableRef = part.url.length > 0 && !part.url.startsWith("data:");
    const basenameFromUrl = urlIsStableRef ? (part.url.split(/[\\/]/).pop() ?? "") : "";
    return {
      fileName: part.filename ?? (basenameFromUrl || `attachment-${index + 1}`),
      mime: part.mime,
      bytes: part.metadata?.sizeBytes ?? 0,
      ...(urlIsStableRef ? { ref: part.url } : {}),
    };
  });
}
