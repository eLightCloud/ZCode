import { repairPersistedRemoteSessionPaths } from "@zcode/core";
import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  parseRewindTriggeredPayload,
  RewindScope,
  RewindStrategy,
  type EventId,
  type MessageWithParts,
  type MessageId,
  type SessionEvent,
  SessionEventType,
  type SessionId,
  type SessionInfo,
  type TargetCompletionVerificationPayload,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import { getConversationMessageProjectionPolicy } from "@zcode/shared";
import { buildSessionSnapshot } from "./mapper.js";
import {
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { getProtocolEventSeq } from "./protocol-event-replay.js";
import { asRecord, stringValue, numberValue } from "./session-mapper-values.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
const SLOW_SNAPSHOT_LOG_THRESHOLD_MS = 1000;

export interface SnapshotPhaseDurationsMs {
  contextUsageBreakdownEvents: number;
  eventSeq: number;
  goalVerificationEvents: number;
  persistedMessages: number;
  persistedSession: number;
  rewindEvents: number;
  target: number;
  todos: number;
  buildSnapshot: number;
}

interface SnapshotWithDiagnostics {
  snapshot: Awaited<ReturnType<typeof buildSessionSnapshot>>;
  phaseDurationsMs: SnapshotPhaseDurationsMs;
}

export async function snapshot(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  knownSession?: SessionInfo | null,
  options: {
    messageLimit?: number;
    modelAvailability?: "all" | "current";
  } = {},
) {
  return (await snapshotWithDiagnostics(context, record, knownSession, options)).snapshot;
}

export async function snapshotWithDiagnostics(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  knownSession?: SessionInfo | null,
  options: {
    messageLimit?: number;
    modelAvailability?: "all" | "current";
  } = {},
): Promise<SnapshotWithDiagnostics> {
  const snapshotStartedAt = Date.now();
  const phaseDurationsMs: SnapshotPhaseDurationsMs = {
    contextUsageBreakdownEvents: 0,
    eventSeq: 0,
    goalVerificationEvents: 0,
    persistedMessages: 0,
    persistedSession: 0,
    rewindEvents: 0,
    target: 0,
    todos: 0,
    buildSnapshot: 0,
  };
  const measureSnapshotPhase = async <T>(
    phase: keyof Omit<SnapshotPhaseDurationsMs, "buildSnapshot">,
    read: () => Promise<T>,
  ): Promise<T> => {
    const phaseStartedAt = Date.now();
    try {
      return await read();
    } finally {
      phaseDurationsMs[phase] = Date.now() - phaseStartedAt;
    }
  };
  const [
    eventSeq,
    persistedMessages,
    session,
    rewindEvents,
    persistedTarget,
    persistedTodos,
    persistedGoalVerificationEvents,
    persistedContextUsageBreakdownEvents,
  ] = await Promise.all([
    measureSnapshotPhase("eventSeq", () =>
      getProtocolEventSeq(context, record, record.deliveryKind),
    ),
    measureSnapshotPhase("persistedMessages", () => readSessionMessages(context, record)),
    knownSession === undefined
      ? measureSnapshotPhase("persistedSession", () =>
          getPersistedSession(context, record.app.sessionId),
        )
      : knownSession,
    measureSnapshotPhase("rewindEvents", () => readSessionRewindEvents(record)),
    measureSnapshotPhase("target", () => readSnapshotTarget(context, record)),
    measureSnapshotPhase("todos", () => readSnapshotTodos(context, record)),
    measureSnapshotPhase("goalVerificationEvents", () =>
      readSessionTargetCompletionVerificationEvents(context, record),
    ),
    measureSnapshotPhase("contextUsageBreakdownEvents", () =>
      readSessionContextUsageBreakdownEvents(record),
    ),
  ]);
  const messages = projectActiveSessionMessages(persistedMessages, session, rewindEvents);
  const buildStartedAt = Date.now();
  const builtSnapshot = await buildSessionSnapshot({
    app: record.app,
    deliveryKind: record.deliveryKind,
    eventSeq,
    fallbackCreatedAt: record.createdAt,
    fallbackUpdatedAt: record.updatedAt,
    lastError: record.restoreWarning,
    messages: limitMessages(messages, options.messageLimit),
    modelAvailability: options.modelAvailability,
    persistedContextUsageBreakdownEvents,
    persistedGoalVerificationEvents,
    session,
    slashCommandOptions: {
      // session snapshot 的 `/` 目录与 workspace presentation 必须给出同一份灰度结论，
      // 否则关闭态下侧栏面板还能看到 `workflow`。
      dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
      env: context.deps.env,
      logger: context.logger,
    },
    stateRevision: record.stateRevision,
    target: persistedTarget,
    todos: persistedTodos,
    workspace: record.workspace,
  });
  phaseDurationsMs.buildSnapshot = Date.now() - buildStartedAt;
  const totalDurationMs = Date.now() - snapshotStartedAt;
  if (totalDurationMs >= SLOW_SNAPSHOT_LOG_THRESHOLD_MS) {
    // SSH 场景下慢点集中在 session snapshot，但旧日志只有总耗时。
    // 超过阈值时记录各子阶段，便于区分 sqlite 等待、消息读取和 projection 构建。
    context.logger?.warn("ZCode Protocol session snapshot slow", {
      durationMs: totalDurationMs,
      event: "zcode_protocol.session_snapshot.slow",
      messageCount: messages.length,
      module: "bootstrap.zcode_protocol",
      phaseDurationsMs,
      sessionId: record.app.sessionId,
      status: "completed",
      workspaceKey: record.workspace.workspaceKey,
      workspacePath: record.workspace.workspacePath,
    });
  }
  return { snapshot: builtSnapshot, phaseDurationsMs };
}

async function readSnapshotTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTarget();
  } catch (error) {
    // goal 是 session_target 的持久业务状态；snapshot 恢复失败时不能静默吞掉，
    // 否则 UI 会误以为历史 session 没有目标。这里保留运行期 projection 并记录协议层日志。
    context.logger?.warn("Failed to read persisted session goal for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.target_read_failed",
      sessionId: record.app.sessionId,
    });
    return undefined;
  }
}

async function readSnapshotTodos(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTodos();
  } catch (error) {
    // todo 是 DB 中的权威短期计划；如果恢复读取失败，UI 需要看到明确日志，
    // 但协议 snapshot 仍可用消息历史继续恢复首屏。
    context.logger?.warn("Failed to read persisted session todos for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.todos_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}

async function readSessionTargetCompletionVerificationEvents(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore?.sessionEntries) {
    return [];
  }
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: record.app.sessionId as SessionId,
      type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
    });
    return entries
      .map((entry, index) =>
        sessionEntryToTargetCompletionVerificationEvent(entry, record.app.sessionId, index),
      )
      .filter((event): event is SessionEvent => event !== null);
  } catch (error) {
    // goal verifier timeline 是 UI 轮次的持久事实；读取失败时不能影响
    // session 主体恢复，但必须留下日志，否则冷启动后分组丢失很难排查。
    context.logger?.warn("Failed to read persisted goal verification entries", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.goal_verification_entries_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}

function sessionEntryToTargetCompletionVerificationEvent(
  entry: {
    id: string;
    sessionID: SessionId;
    time: { created: number; updated: number };
    data: unknown;
  },
  fallbackSessionId: string,
  index: number,
): SessionEvent | null {
  const data = asRecord(entry.data);
  const payload = readTargetCompletionVerificationPayload(data.payload);
  if (!payload) {
    return null;
  }
  const eventId = stringValue(data.eventId) ?? entry.id;
  const traceId = stringValue(data.traceId) ?? "trace_restored_goal_verification";
  const turnId = stringValue(data.turnId);
  return {
    id: eventId as EventId,
    payload,
    sequenceNumber: numberValue(data.sequenceNumber) ?? index + 1,
    sessionId: (entry.sessionID ?? fallbackSessionId) as SessionId,
    timestamp: new Date(entry.time.updated || entry.time.created),
    traceId: traceId as TraceId,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    type: SessionEventType.TargetCompletionVerification,
  };
}

function readTargetCompletionVerificationPayload(
  value: unknown,
): TargetCompletionVerificationPayload | null {
  const record = asRecord(value);
  const targetId = stringValue(record.targetId);
  const verificationId = stringValue(record.verificationId);
  const status = stringValue(record.status);
  if (!targetId || !verificationId || !isTargetCompletionVerificationStatus(status)) {
    return null;
  }
  const verification = asGoalCompletionVerification(record.verification);
  const goalIteration = numberValue(record.goalIteration);
  const anchorAssistantMessageId = stringValue(record.anchorAssistantMessageId);
  const anchorTurnId = stringValue(record.anchorTurnId);
  return {
    targetId,
    verificationId,
    status,
    ...(verification ? { verification } : {}),
    ...(goalIteration ? { goalIteration } : {}),
    ...(anchorAssistantMessageId
      ? { anchorAssistantMessageId: anchorAssistantMessageId as MessageId }
      : {}),
    ...(anchorTurnId ? { anchorTurnId: anchorTurnId as TurnId } : {}),
  };
}

function isTargetCompletionVerificationStatus(
  status: string | undefined,
): status is TargetCompletionVerificationPayload["status"] {
  return (
    status === "started" ||
    status === "completed" ||
    status === "failed_closed" ||
    status === "cancelled"
  );
}

function asGoalCompletionVerification(
  value: unknown,
): TargetCompletionVerificationPayload["verification"] | undefined {
  const record = asRecord(value);
  if (typeof record.passed !== "boolean") {
    return undefined;
  }
  const reason = stringValue(record.reason);
  if (!reason) {
    return undefined;
  }
  return {
    nextAction: stringValue(record.nextAction),
    passed: record.passed,
    reason,
  };
}

function limitMessages<T>(messages: T[], limit?: number): T[] {
  return limit && limit > 0 ? messages.slice(-limit) : messages;
}

export async function readSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  if (!context.deps.sessionStore) return [];
  return await context.deps.sessionStore.messages({
    sessionID: record.app.sessionId as SessionId,
  });
}

async function readSessionContextUsageBreakdownEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.ModelComplete);
}

export async function readActiveSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<MessageWithParts[]> {
  const [messages, session, rewindEvents] = await Promise.all([
    readSessionMessages(context, record),
    getPersistedSession(context, record.app.sessionId),
    readSessionRewindEvents(record),
  ]);
  return projectActiveSessionMessages(messages, session, rewindEvents);
}

async function readSessionRewindEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.RewindTriggered);
}

export function projectActiveSessionMessages(
  messages: MessageWithParts[],
  session: SessionInfo | null | undefined,
  rewindEvents: readonly SessionEvent[],
): MessageWithParts[] {
  const activeConversationRewinds: ActiveConversationRewindPayload[] = [];
  const sessionRewindPayload = activeConversationRewindPayloadFromSession(session);
  if (sessionRewindPayload) {
    activeConversationRewinds.push(sessionRewindPayload);
  }
  let activeMessages = applyRewindBranch(messages, messages, {
    createdMessageId: sessionRewindPayload?.createdMessageId,
    keptMessageIds: session?.revert?.keptMessageIDs,
    targetMessageId: sessionRewindPayload?.targetMessageId,
  });

  for (const event of rewindEvents) {
    const payload = parseActiveConversationRewindPayload(event);
    if (!payload?.targetMessageId) {
      continue;
    }
    activeConversationRewinds.push(payload);
    activeMessages = applyRewindBranch(activeMessages, messages, payload);
  }

  return filterRewindCommandAckMessages(activeMessages, activeConversationRewinds);
}

type ActiveConversationRewindPayload = {
  createdMessageId: MessageId;
  targetMessageId: MessageId;
};

function activeConversationRewindPayloadFromSession(
  session: SessionInfo | null | undefined,
): ActiveConversationRewindPayload | null {
  const createdMessageId = session?.revert?.createdMessageID;
  const targetMessageId = session?.revert?.targetMessageID;
  if (!createdMessageId || !targetMessageId) {
    return null;
  }
  return { createdMessageId, targetMessageId };
}

function parseActiveConversationRewindPayload(
  event: SessionEvent,
): ActiveConversationRewindPayload | null {
  try {
    const payload = parseRewindTriggeredPayload(event.payload);
    if (
      payload.strategy !== RewindStrategy.ActiveChain ||
      (payload.scope !== RewindScope.Conversation && payload.scope !== RewindScope.Both) ||
      !payload.createdMessageId ||
      !payload.targetMessageId
    ) {
      // core 会为不可用的 rewind 记录 unavailable event，但这类事件没有 createdMessageId。
      // 它不是新的 active branch 起点，协议投影不能用它裁剪消息，否则连续编辑会把可见消息投空。
      return null;
    }
    return {
      createdMessageId: payload.createdMessageId,
      targetMessageId: payload.targetMessageId,
    };
  } catch {
    return null;
  }
}

function filterRewindCommandAckMessages(
  messages: MessageWithParts[],
  activeConversationRewinds: readonly ActiveConversationRewindPayload[],
): MessageWithParts[] {
  if (activeConversationRewinds.length === 0) {
    return messages;
  }
  const targetByNoticeMessageId = new Map<MessageId, MessageId>();
  for (const rewind of activeConversationRewinds) {
    targetByNoticeMessageId.set(rewind.createdMessageId, rewind.targetMessageId);
  }
  return messages.filter((message) => !isRewindCommandAckMessage(message, targetByNoticeMessageId));
}

function isRewindCommandAckMessage(
  message: MessageWithParts,
  targetByNoticeMessageId: ReadonlyMap<MessageId, MessageId>,
): boolean {
  if (message.info.role !== "assistant") {
    return false;
  }
  const targetMessageId = targetByNoticeMessageId.get(message.info.parentID);
  if (!targetMessageId) {
    return false;
  }
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  const ackText = `Rewound conversation to before message ${targetMessageId}.`;
  // 内部 `/rewind conversation <messageId>` 的成功回执可能被旧事件投影落成
  // assistant 文本。它只是编辑/重试的控制命令 ACK，刷新或恢复时不能再渲染给用户。
  return text === ackText || text.endsWith(`\n${ackText}`);
}

export function isUserVisibleSessionMessage(message: MessageWithParts): boolean {
  if (message.info.role !== "user") {
    return true;
  }
  const policy = getConversationMessageProjectionPolicy(message);
  return policy === "realUserInput" || policy === "timelineOnly";
}

function applyRewindBranch(
  activeMessages: MessageWithParts[],
  allMessages: MessageWithParts[],
  options: {
    createdMessageId?: MessageId;
    keptMessageIds?: readonly MessageId[];
    targetMessageId?: MessageId;
  },
): MessageWithParts[] {
  if (!options.targetMessageId) {
    return activeMessages;
  }

  if (options.keptMessageIds) {
    // 连续 rewind 后，账本里的 target 前缀不等于 active branch 前缀。
    // 优先使用 runtime 在 rewind 当时保存的 keptMessageIDs，避免旧分支在 snapshot/readMessages 中复活。
    const messagesById = new Map(allMessages.map((message) => [message.info.id, message]));
    const keptMessages = options.keptMessageIds
      .map((messageId) => messagesById.get(messageId))
      .filter((message): message is MessageWithParts => message !== undefined);
    if (!options.createdMessageId) {
      return keptMessages;
    }

    const createdIndex = allMessages.findIndex(
      (message) => message.info.id === options.createdMessageId,
    );
    return createdIndex >= 0 ? [...keptMessages, ...allMessages.slice(createdIndex)] : keptMessages;
  }

  const targetIndex = activeMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    return activeMessages;
  }
  const keptMessages = activeMessages.slice(0, targetIndex);
  if (!options.createdMessageId) {
    return keptMessages;
  }

  const createdIndex = allMessages.findIndex(
    (message) => message.info.id === options.createdMessageId,
  );
  if (createdIndex < 0) {
    return keptMessages;
  }

  // conversation rewind 的持久化账本会保留被回滚的旧分支。
  // UI snapshot/readMessages 必须投影 active branch，否则编辑重发后会同时看到错发原文和新消息。
  return [...keptMessages, ...allMessages.slice(createdIndex)];
}

export async function getPersistedSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<SessionInfo | null> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore) return null;
  const session = await sessionStore.getSession(sessionId as SessionId);
  if (!session) return null;
  // 协议冷恢复先用 session.path 创建 runtime，必须在物化前清理旧版 identity/cwd 混写数据。
  return await repairPersistedRemoteSessionPaths(sessionStore, session, {
    onPersistenceFailure: (error) => {
      context.logger?.warn("Session path repair persistence failed; using in-memory repair", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.session.path_repair.persist_failed",
        sessionId,
      });
    },
  });
}
