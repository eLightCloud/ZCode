import { SessionEventType } from "../deps.js";

import type { MessageId, QueryId, TraceContext, TurnAttachment } from "../deps.js";

import { summarizeTurnAttachmentsForEvent } from "../helpers/index.js";

import type { ExecuteTurnOptions } from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

export function createTurnStartedEvent(
  this: AgentRuntimeInternal,
  attachments: TurnAttachment[] | undefined,
  executionStartedAt: number,
  displayInput: string,
  userMessageId: MessageId,
  options: ExecuteTurnOptions | undefined,
  queryId: QueryId,
  turnTraceContext: TraceContext,
) {
  const attachmentMetas = summarizeTurnAttachmentsForEvent(attachments);
  const turnStartedEvent = this.createEvent(
    SessionEventType.TurnStarted,
    {
      executionStartedAt,
      turnNumber: this.turnNumber,
      input: displayInput,
      messageId: userMessageId,
      inputId: options?.inputId,
      ...(options?.automationId
        ? { automationId: options.automationId }
        : options?.offPeakTaskId
          ? {
              offPeakTaskId: options.offPeakTaskId,
              ...(options.offPeakRunType ? { offPeakRunType: options.offPeakRunType } : {}),
            }
          : {}),
      foregroundExecutionId: this.activeForegroundExecution?.foregroundExecutionId,
      queryId,
      inputSource: options?.inputSource,
      inputVisibility: options?.inputVisibility,
      originMeta: options?.originMeta,
      ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
      ...(options?.backgroundSource ? { backgroundSource: options.backgroundSource } : {}),
      targetId: options?.targetId,
      ...(options?.intent ? { intent: options.intent } : {}),
      ...(attachmentMetas ? { attachments: attachmentMetas } : {}),
    },
    turnTraceContext,
  );
  return turnStartedEvent;
}
