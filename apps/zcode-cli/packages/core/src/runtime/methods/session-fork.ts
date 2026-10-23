import type { MessageId } from "../deps.js";

import type { AgentRuntimeInternal } from "../internal.js";

import type {
  ConversationBeforeInputForkOptions,
  StableConversationForkOptions,
  WorkspaceForkResult,
} from "../types.js";

import { stableForkError } from "./fork-model-selection.js";

import {
  conversationHistoryBeforeInput,
  forkSourceMessagesForSession,
  stableForkHistoryMessages,
} from "./fork-history.js";

import { commitAtomicConversationFork } from "./fork-atomic.js";

export { createForkIdentityMap } from "./fork-identity.js";

export type { ForkIdentityMap } from "./fork-identity.js";

export { buildAtomicForkNotice } from "./fork-notice.js";

export {
  createSelectionSideConversation,
  selectionSideChatHistoryMessages,
} from "./fork-atomic.js";

export { createForkedSession, forkConversationFromMessage } from "./fork-legacy.js";

export {
  activeForkTranscriptMessages,
  buildForkHistoryMessages,
  conversationHistoryBeforeInput,
  forkSourceMessagesForSession,
  resolveForkHistoryEndIndex,
  stableForkHistoryMessages,
} from "./fork-history.js";

export {
  copyGoalStateForFork,
  deriveForkedGoalStatusFromCopiedVerifications,
} from "./fork-goals.js";

/** V4 running stable fork 公共入口：纯 transcript copy，不读取/恢复 workspace checkpoint。 */
export async function forkStableConversationAtMessage(
  this: AgentRuntimeInternal,
  options: StableConversationForkOptions,
): Promise<WorkspaceForkResult> {
  if (!options.sourceCommandId.trim()) {
    throw stableForkError("Stable fork sourceCommandId must not be empty");
  }
  if (!this.sessionStore?.commitForkBundle) {
    throw stableForkError("Stable fork requires commitForkBundle");
  }
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) throw stableForkError(`Session not found: ${this.sessionId}`);
  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const history = stableForkHistoryMessages(activeMessages, options.target);
  return await commitAtomicConversationFork(this, {
    modelSelection: options.modelSelection,
    forkedSessionId: options.forkedSessionId,
    goalBoundary: options.goalBoundary,
    messages: history,
    parentSession,
    revisionAtDecision: options.revisionAtDecision,
    sourceCommandId: options.sourceCommandId,
    target: options.target,
    targetMessageId: options.target.boundaryMessageId as MessageId,
    traceContext: options.traceContext ?? this.rootTraceContext,
  });
}

/** compact-covered edit：复制目标真实用户输入之前的 active conversation prefix。 */
export async function forkConversationBeforeMessage(
  this: AgentRuntimeInternal,
  options: ConversationBeforeInputForkOptions,
): Promise<WorkspaceForkResult> {
  if (!this.sessionStore?.commitForkBundle) {
    throw stableForkError("Fork requires a session adapter");
  }
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) throw stableForkError(`Session not found: ${this.sessionId}`);
  const parentMessages = await this.sessionStore.messages({
    sessionID: this.sessionId,
  });
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const prefix = conversationHistoryBeforeInput(activeMessages, options.targetMessageId);
  return await commitAtomicConversationFork(this, {
    commandFact: options.commandFact,
    modelSelection: options.modelSelection,
    forkedSessionId: options.forkedSessionId,
    goalBoundary: options.goalBoundary,
    initialInput: options.initialInput,
    messages: prefix,
    parentSession,
    sourceCommandId: options.sourceCommandId,
    targetMessageId: options.targetMessageId,
    traceContext: options.traceContext ?? this.rootTraceContext,
  });
}
