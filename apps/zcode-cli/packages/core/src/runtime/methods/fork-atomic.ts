import { resolveExecutionState } from "@zcode/shared";

import { buildExecutionStateEntry, readRuntimeExecutionState } from "../execution-state.js";

import { type ForkCommitBundle } from "@zcode/contracts";

import {
  RewindStrategy,
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SessionEventType,
  createMessageId,
  createSessionId,
  traceContextToLogContext,
} from "../deps.js";

import type {
  MessageId,
  MessageWithParts,
  SessionId,
  SessionInfo,
  TraceContext,
  TurnId,
} from "../deps.js";

import { cloneMessageForFork, clonePartForFork } from "../helpers/index.js";

import type { AgentRuntimeInternal } from "../internal.js";

import type {
  SelectionSideChatCreateOptions,
  StableConversationForkGoalBoundary,
  StableConversationForkTarget,
  WorkspaceForkResult,
} from "../types.js";

import type { ModelSelection } from "@zcode/contracts";

import {
  buildModelSelectionEntry,
  resolveForkModelSelection,
  stableForkError,
} from "./fork-model-selection.js";

import {
  buildAtomicForkNotice,
  buildSelectionSideChatBoundary,
  withoutSelectionSideChatGoalBoundary,
} from "./fork-notice.js";

import {
  buildForkedSessionInput,
  cloneVerifierEntryForAtomicFork,
  collectForkGoalSnapshots,
  collectVerifierEntryIds,
  createForkIdentityMap,
  remapGoalForFork,
} from "./fork-identity.js";

import { forkSourceMessagesForSession } from "./fork-history.js";

export async function commitAtomicConversationFork(
  runtime: AgentRuntimeInternal,
  options: {
    commandFact?: ForkCommitBundle["commandFact"];
    modelSelection?: ModelSelection;
    forkedSessionId?: SessionId;
    goalBoundary: StableConversationForkGoalBoundary;
    initialInput?: ForkCommitBundle["initialInput"];
    messages: readonly MessageWithParts[];
    parentSession: SessionInfo;
    revisionAtDecision?: number;
    sourceCommandId: string;
    targetMessageId: MessageId;
    target?: StableConversationForkTarget;
    traceContext: TraceContext;
    kind?: "fork" | "selection_side_chat";
  },
): Promise<WorkspaceForkResult> {
  const store = runtime.sessionStore;
  if (!store?.commitForkBundle) {
    throw stableForkError("Stable fork requires commitForkBundle");
  }
  const childSessionId = options.forkedSessionId ?? createSessionId();
  const kind = options.kind ?? "fork";
  const currentExecutionState = readRuntimeExecutionState(runtime);
  const historicalInfo = [...options.messages]
    .reverse()
    .find((message) => message.info.role === "assistant")?.info;
  // 保留原 stable fork 的历史权限选择，不能让新增 entry 把它覆盖成父任务当前权限。
  const executionState =
    kind === "selection_side_chat" || historicalInfo?.role !== "assistant"
      ? currentExecutionState
      : resolveExecutionState(historicalInfo);
  // 辅助对话明确不复制 Goal target/verifier entries，不能仍将
  // 父消息的 goalBoundary 交给 strict fork clone，否则任意 Goal 状态都会要求不存在的
  // child-local identity。只移除用于 Goal 恢复的 boundary，保留父对话正文作为模型上下文。
  const sourceMessages =
    kind === "selection_side_chat"
      ? options.messages.map(withoutSelectionSideChatGoalBoundary)
      : options.messages;
  const modelSelection = resolveForkModelSelection(runtime, sourceMessages, options.modelSelection);
  const referencedEntryIds =
    kind === "selection_side_chat"
      ? new Set<string>()
      : collectVerifierEntryIds(sourceMessages, options.goalBoundary);
  const allEntries = referencedEntryIds.size
    ? await store.sessionEntries?.({
        sessionID: runtime.sessionId,
        type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
      })
    : [];
  if (referencedEntryIds.size && !allEntries) {
    throw stableForkError("Stable fork verifier boundary cannot be loaded");
  }
  const entryById = new Map((allEntries ?? []).map((entry) => [entry.id, entry]));
  const entries = [...referencedEntryIds].map((id) => {
    const entry = entryById.get(id);
    if (!entry) {
      throw stableForkError("Stable fork verifier boundary references missing entries", {
        verificationEntryId: id,
      });
    }
    return entry;
  });
  const goalSnapshots =
    kind === "selection_side_chat"
      ? []
      : collectForkGoalSnapshots(sourceMessages, options.goalBoundary);
  const identities = createForkIdentityMap({
    childSessionId,
    entries,
    goalSnapshots,
    messages: sourceMessages,
    parentSessionId: runtime.sessionId,
  });
  const copiedMessages = sourceMessages.map((message) => {
    const nextMessageId = identities.messageIds.get(message.info.id)!;
    const cloned = {
      info: cloneMessageForFork(message.info, {
        forkedSessionId: childSessionId,
        messageIdMap: identities.messageIds,
        nextMessageId,
        turnIdMap: identities.turnIds,
        productTurnIdMap: identities.productTurnIds,
        targetIdMap: identities.targetIds,
        verificationEntryIdMap: identities.verifierEntryIds,
        strictLocalReferences: true,
      }),
      parts: message.parts.map((part) =>
        clonePartForFork(part, {
          forkedSessionId: childSessionId,
          nextMessageId,
          nextPartId: identities.partIds.get(part.id),
          partIdMap: identities.partIds,
          messageIdMap: identities.messageIds,
          turnIdMap: identities.turnIds,
          targetIdMap: identities.targetIds,
          verificationIdMap: identities.verificationIds,
          toolCallIdMap: identities.toolCallIds,
          strictLocalReferences: true,
        }),
      ),
    };
    if (kind !== "selection_side_chat") return cloned;
    // 副屏继承历史仅供模型参考；UI 从空白副屏开始，避免把它误认成普通 fork。
    return {
      ...cloned,
      info: {
        ...cloned.info,
        visibility: "model-only" as const,
        semantics: {
          origin: cloned.info.semantics?.origin ?? "migration",
          kind: cloned.info.semantics?.kind ?? "system_reminder",
          ...(cloned.info.semantics?.source ? { source: cloned.info.semantics.source } : {}),
          uiVisibility: "hidden" as const,
          providerVisibility: "visible" as const,
          transcriptVisibility: "hidden" as const,
        },
      },
    };
  });
  const clonedEntries = entries.map((entry) => cloneVerifierEntryForAtomicFork(entry, identities));
  const modelSelectionEntry = buildModelSelectionEntry(childSessionId, modelSelection);
  if (kind === "selection_side_chat") {
    copiedMessages.push(buildSelectionSideChatBoundary(runtime, childSessionId, modelSelection));
  } else {
    copiedMessages.push(
      ...buildAtomicForkNotice(runtime, {
        identities,
        modelSelection,
        executionState,
        sourceCommandId: options.sourceCommandId,
        targetMessageId: options.targetMessageId,
      }),
    );
  }
  const commandFact = options.commandFact ?? {
    parentSessionId: String(runtime.sessionId),
    sourceCommandId: options.sourceCommandId,
    ack: {
      commandId: options.sourceCommandId,
      status: "accepted" as const,
      revisionAtDecision: options.revisionAtDecision ?? 0,
      result: {
        type: kind === "selection_side_chat" ? "createSelectionSideSession" : "forkAssistant",
        sessionId: String(childSessionId),
      },
    },
    metadata: {
      forkOrigin: {
        parentSessionId: String(runtime.sessionId),
        targetMessageId: String(options.targetMessageId),
      },
      ...(options.target ? { forkTarget: options.target } : {}),
    },
  };
  const goal =
    kind !== "selection_side_chat" && options.goalBoundary.kind === "snapshot"
      ? {
          source: remapGoalForFork(options.goalBoundary.target, identities),
          status: options.goalBoundary.target.status,
        }
      : undefined;
  const committedChild = await store.commitForkBundle({
    child: buildForkedSessionInput(runtime, options.parentSession, childSessionId, kind),
    messages: copiedMessages,
    copySources: {
      messages: Object.fromEntries(
        [...identities.messageIds].map(([source, target]) => [target, source]),
      ),
      parts: Object.fromEntries(
        [...identities.partIds].map(([source, target]) => [target, source]),
      ),
    },
    // 选型 entry 与 child/message/verifier 同事务提交；否则 child 首次注册能读到
    // 运行态，冷恢复却会回到 workspace 默认 thought。entry 的磁盘包装由 adapter 负责。
    // Plan 必须与权限一并进入原子的 child bundle，不能只复制创建时的旧 permission。
    entries: [
      ...clonedEntries.map((item) => item.entry),
      modelSelectionEntry,
      buildExecutionStateEntry(childSessionId, executionState),
    ],
    ...(goal ? { goal } : {}),
    ...(options.initialInput ? { initialInput: options.initialInput } : {}),
    commandFact,
  });
  const forkedSessionId = committedChild.id;
  if (kind !== "selection_side_chat") {
    const forkedEvent = runtime.createEvent(
      SessionEventType.SessionForked,
      {
        originalSessionId: runtime.sessionId,
        forkedSessionId,
        forkPoint: options.messages.length,
        targetMessageId: options.targetMessageId,
        restoredFileCount: 0,
        strategy: RewindStrategy.ForkRequired,
      },
      options.traceContext,
    );
    try {
      await runtime.appendEvent(forkedEvent, options.traceContext);
    } catch (error) {
      runtime.logger?.warn("Parent fork event append failed after durable fork commit", {
        ...traceContextToLogContext(options.traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "session.fork.parent_event.failed_after_commit",
        forkedSessionId,
        module: "core.runtime",
        parentSessionId: runtime.sessionId,
      });
    }
  }
  return {
    copiedMessageCount: options.messages.length,
    forkedSessionId,
    parentSessionId: runtime.sessionId,
    targetMessageId: options.targetMessageId,
    restoredFiles: [],
    response:
      kind === "selection_side_chat"
        ? `Created selection side chat ${forkedSessionId}.`
        : `Forked session ${forkedSessionId} from message ${options.targetMessageId}: copied ${options.messages.length} messages.`,
  };
}

/**
 * 副屏创建使用父 active transcript 的稳定落盘边界。正在生成时只保留已提交的本轮
 * real-user input，排除其后的 assistant/tool 增量；goal、queue 与阻塞运行态不复制。
 */
export async function createSelectionSideConversation(
  this: AgentRuntimeInternal,
  options: SelectionSideChatCreateOptions,
): Promise<WorkspaceForkResult> {
  if (!options.sourceCommandId.trim()) {
    throw stableForkError("Selection side chat sourceCommandId must not be empty");
  }
  if (!this.sessionStore?.commitForkBundle) {
    throw stableForkError("Selection side chat requires commitForkBundle");
  }
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) throw stableForkError(`Session not found: ${this.sessionId}`);
  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const history = selectionSideChatHistoryMessages(activeMessages, this.activeTurn?.turnId);
  const targetMessageId = history.at(-1)?.info.id ?? createMessageId();
  return await commitAtomicConversationFork(this, {
    modelSelection: options.modelSelection,
    goalBoundary: { kind: "none" },
    kind: "selection_side_chat",
    messages: history,
    parentSession,
    revisionAtDecision: options.revisionAtDecision,
    sourceCommandId: options.sourceCommandId,
    targetMessageId,
    traceContext: options.traceContext ?? this.rootTraceContext,
  });
}

export function selectionSideChatHistoryMessages(
  activeMessages: readonly MessageWithParts[],
  activeTurnId?: TurnId,
): MessageWithParts[] {
  if (!activeTurnId) return [...activeMessages];
  const activeUserIndex = activeMessages.findIndex(
    (message) =>
      message.info.role === "user" &&
      message.info.anchor?.turnId === activeTurnId &&
      message.info.anchor.origin === "realUser",
  );
  if (activeUserIndex >= 0) return activeMessages.slice(0, activeUserIndex + 1);
  const activeTurnStart = activeMessages.findIndex(
    (message) => message.info.anchor?.turnId === activeTurnId,
  );
  return activeTurnStart >= 0 ? activeMessages.slice(0, activeTurnStart) : [...activeMessages];
}
