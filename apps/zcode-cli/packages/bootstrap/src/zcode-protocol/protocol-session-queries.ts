import { isAuxiliarySessionKind } from "@zcode/shared";
import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../zcode-protocol-v4/task-list-session-membership.js";
import {
  type MessageWithParts,
  SessionEventType,
  type SessionId,
  type SessionInfo,
  type UsageStorePort,
} from "@zcode/contracts";
import {
  zcodeProtocolErrorCodes,
  zcodeSessionEventsParamsSchema,
  zcodeSessionListParamsSchema,
  zcodeSessionMessagesParamsSchema,
  zcodeSessionReadParamsSchema,
  elideSessionSnapshotForIndex,
  zcodeSessionSubscribeParamsSchema,
  zcodeSessionSubagentsParamsSchema,
  zcodeTaskTokenUsageParamsSchema,
  zcodeUsageStatsParamsSchema,
} from "@zcode/shared";
import { buildWorkspaceRef, mapSessionInfo, resolveSessionContextUsage } from "./mapper.js";
import {
  ProtocolRequestError,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";
import { buildAppUsageSnapshot, resolveTzOffsetMs } from "./usage-stats-builder.js";
import {
  collectSubagentChildSessionIds,
  paginateEndedSubagents,
  projectSessionSubagents,
} from "./subagent-session-query.js";
import {
  snapshot,
  readSessionMessages,
  getPersistedSession,
  projectActiveSessionMessages,
  readActiveSessionMessages,
} from "./protocol-session-snapshot.js";
import { readProtocolSessionEvents, getProtocolEventSeq } from "./protocol-event-replay.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
export async function listSessions(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionListParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  // 显式 ID 查询只读持久化身份，供 Host 修复旧索引；不能为了识别 child 激活 runtime。
  const candidates = params.sessionIds
    ? await Promise.all(params.sessionIds.map((id) => store?.getSession(id as SessionId) ?? null))
    : store
      ? await store.listSessions({
          directory: params.workspace?.workspacePath,
          limit: params.limit ?? 50,
          taskTypes: [...TASK_LIST_SESSION_TYPES],
        })
      : [];
  const scoped = await Promise.all(
    candidates.map(async (session) => {
      if (!session) return null;
      if (!params.workspace) return session.time.deleted === undefined ? session : null;
      const expectedKey =
        params.workspace.workspaceIdentity?.trim() || params.workspace.workspacePath;
      const visited = new Set<string>();
      let current: SessionInfo | null = session;
      while (current && current.time.deleted === undefined && !visited.has(current.id)) {
        visited.add(current.id);
        const path = current.path || current.directory;
        const key = current.workspaceID?.trim() || path;
        if (key === expectedKey) return session;
        // 子 runtime 的历史行可能只有 cwd，没有远端 workspace identity；仅精确 ID 查询
        // 可凭持久化父链证明归属。目录或显式身份不同就拒绝，不回写身份、不激活 runtime。
        if (
          !params.sessionIds ||
          !isAuxiliarySessionKind(current.taskType) ||
          !current.parentID ||
          path !== params.workspace.workspacePath ||
          (current.workspaceID?.trim() && key !== path)
        )
          return null;
        current = (await store?.getSession(current.parentID)) ?? null;
        if (current && (current.path || current.directory) !== params.workspace.workspacePath)
          return null;
      }
      return null;
    }),
  );
  const stored = scoped.filter((session): session is SessionInfo => session !== null);
  const storedIds = new Set(stored.map((session) => String(session.id)));
  const sessions = stored.map((session) =>
    mapSessionInfo({
      session,
      workspace:
        params.workspace ?? buildWorkspaceRef({ workspacePath: session.path ?? session.directory }),
    }),
  );
  if (params.sessionIds) return { sessions };
  for (const record of context.sessions.values()) {
    if (record.persistence === "deferred") continue;
    if (!isTaskListSessionType(record.taskType)) continue;
    if (storedIds.has(record.app.sessionId)) continue;
    if (params.workspace && params.workspace.workspaceKey !== record.workspace.workspaceKey)
      continue;
    sessions.push(
      mapSessionInfo({
        app: record.app,
        workspace: record.workspace,
        taskType: record.taskType,
        parentSessionId: record.parentSessionId,
      }),
    );
  }
  return { sessions };
}

export async function listSessionSubagents(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  persistedMessages?: MessageWithParts[],
) {
  const params = parseParams(zcodeSessionSubagentsParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  const liveParent = context.sessions.get(params.sessionId);
  if (!store) {
    return {
      revision: liveParent?.stateRevision ?? 0,
      childSessionIds: [],
      running: [],
      ended: { total: 0, items: [] },
    };
  }

  const parentSession = await store.getSession(params.sessionId as SessionId);
  if (!parentSession) {
    // 诊断：hydrate 会复用子任务种子读取；若 task index/旧 ACP task 残留了无效 ID，
    // 这里会把“持久化记录不存在”包装成 v4.hydrate，必须记录调用阶段而不是只看错误文本。
    context.logger?.warn("ZCode Protocol session subagents has no persisted parent", {
      activeSessionCount: context.sessions.size,
      activeSession: Boolean(liveParent),
      event: "zcode_protocol.session.persisted_missing",
      module: "bootstrap.zcode_protocol",
      operation: "session_subagents",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  const messages = persistedMessages ?? (await store.messages({ sessionID: parentSession.id }));
  const parentEvents = liveParent
    ? await liveParent.eventStore.getEvents(parentSession.id).catch(() => [])
    : [];
  const childSessionIds = collectSubagentChildSessionIds(parentSession, messages, parentEvents);
  const childEntries = await Promise.all(
    childSessionIds.map(async (childSessionId) => {
      const childSession = await store.getSession(childSessionId as SessionId);
      if (!childSession || childSession.taskType !== "subagent_child") return null;
      const childMessages = await store.messages({
        sessionID: childSession.id,
      });
      const liveChild = context.sessions.get(childSessionId);
      const childProjection = liveChild
        ? await liveChild.app.runtime.getProjection().catch(() => undefined)
        : undefined;
      return { childMessages, childProjection, childSession, childSessionId };
    }),
  );
  const persistedChildren = childEntries.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );
  const parentProjection = liveParent
    ? await liveParent.app.runtime.getProjection().catch(() => undefined)
    : undefined;
  const projection = projectSessionSubagents({
    revision: liveParent?.stateRevision ?? parentSession.time.updated,
    parentSession,
    messages,
    childSessionsById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childSession]),
    ),
    childMessagesById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childMessages]),
    ),
    childProjectionsById: new Map(
      persistedChildren.flatMap((entry) =>
        entry.childProjection ? [[entry.childSessionId, entry.childProjection]] : [],
      ),
    ),
    ...(parentProjection ? { parentProjection } : {}),
    ...(parentEvents.length > 0 ? { parentEvents } : {}),
  });
  const ended = paginateEndedSubagents(projection.ended, {
    cursor: params.endedCursor,
    limit: params.endedLimit,
  });
  return {
    revision: projection.revision,
    childSessionIds: persistedChildren.map((entry) => entry.childSessionId),
    running: projection.running,
    ended: {
      total: projection.ended.length,
      items: ended.items,
      ...(ended.nextCursor ? { nextCursor: ended.nextCursor } : {}),
    },
  };
}

const APP_USAGE_RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30 };

export async function getUsageStats(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeUsageStatsParamsSchema, rawParams ?? {});
  const timeZone = params.timeZone ?? "UTC";
  const until = Date.now();
  const tzOffsetMs = resolveTzOffsetMs(timeZone, until);
  const rangeDays = APP_USAGE_RANGE_DAYS[params.range] ?? 30;
  const since = params.range === "all" ? 0 : until - rangeDays * 86_400_000;
  const buildOptions = {
    range: params.range,
    timeZone,
    tzOffsetMs,
    generatedAt: until,
    since,
    until,
  };

  // SessionStorePort 与 UsageStorePort 是分离接口，但实际 store 同时实现两者；
  // 沿用 core/usage-observability 的运行时收窄方式访问只读聚合方法。
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.queryAppUsage) {
    // 无 usage store（不应发生）：返回空快照而非抛错，便于 UI 显示空态。
    return buildAppUsageSnapshot(
      {
        totals: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          modelRequestCount: 0,
          modelErrorCount: 0,
          avgTimeToFirstTokenMs: null,
        },
        turnTotals: {
          totalSessions: 0,
          totalTurns: 0,
          avgTurnDurationMs: null,
          longestSessionMs: 0,
        },
        toolTotals: { toolCallCount: 0, toolErrorCount: 0 },
        models: [],
        tools: [],
        days: [],
        dayModels: [],
      },
      buildOptions,
    );
  }

  const result = await usageStore.queryAppUsage({ since, until, tzOffsetMs });
  return buildAppUsageSnapshot(result, buildOptions);
}

export async function readSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionReadParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    deliveryKind: params.deliveryKind,
    operation: "session_read",
  });
  record.deliveryKind = params.deliveryKind ?? record.deliveryKind;
  const result = await snapshot(context, record, undefined, {
    messageLimit: params.messageLimit,
    modelAvailability: "current",
  });
  // task index resync 只需标题/搜索文本/可见性/状态，完整历史单行可达 ~15MB 会打满 host stdio；
  // 先按 full 构建再裁剪大载荷，保证 index 派生字段与 full 同源一致。
  return params.contentProfile === "index" ? elideSessionSnapshotForIndex(result) : result;
}

/**
 * V4 冷恢复 usage 的窄读取：复用 legacy snapshot 的 meter 计算，但不映射完整协议快照。
 */
export async function readSessionContextUsage(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  persistedMessages?: MessageWithParts[],
) {
  const record = context.sessions.get(sessionId);
  if (!record) return undefined;
  const [resolvedPersistedMessages, session, events] = await Promise.all([
    persistedMessages ?? readSessionMessages(context, record),
    getPersistedSession(context, sessionId),
    record.eventStore.getEvents(sessionId as SessionId),
  ]);
  // 保持 legacy buildSessionSnapshot 的取数顺序：先固定持久事实，再读取 runtime
  // projection。运行中首订阅若恰逢 ModelComplete/rewind，不能因窄读把 projection
  // 提前到并行阶段而制造新的跨水位组合。
  const projection = await record.app.runtime.getProjection();
  const messages = projectActiveSessionMessages(
    resolvedPersistedMessages,
    session,
    events.filter((event) => event.type === SessionEventType.RewindTriggered),
  );
  return resolveSessionContextUsage({
    messages,
    persistedContextUsageBreakdownEvents: events,
    projection,
  });
}

export async function readMessages(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionMessagesParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const allMessages = await readActiveSessionMessages(context, record);
  const afterMessageIndex = params.afterMessageId
    ? allMessages.findIndex((message) => String(message.info.id) === params.afterMessageId)
    : -1;
  const messages = afterMessageIndex >= 0 ? allMessages.slice(afterMessageIndex + 1) : allMessages;
  return {
    messages: params.limit ? messages.slice(-params.limit) : messages,
  };
}

export async function readEvents(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionEventsParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  return {
    events: await readProtocolSessionEvents(context, record, record.deliveryKind, {
      afterSeq: params.afterSeq,
      limit: params.limit,
    }),
  };
}

export async function subscribeSession(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionSubscribeParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  record.deliveryKind = params.deliveryKind;
  // 兼容保护：旧 replayable 流没有 unsubscribe RPC。这里只记录真正的 subscribe，
  // 不复用会被 session/read 写入的 deliveryKind，避免普通读取永久阻止 resident 回收。
  record.legacyStreamSubscribed = true;
  const events =
    params.afterSeq === undefined
      ? []
      : await readProtocolSessionEvents(context, record, record.deliveryKind, {
          afterSeq: params.afterSeq,
        });
  return {
    eventSeq: await getProtocolEventSeq(context, record, record.deliveryKind),
    events,
    sessionId: params.sessionId,
    snapshot: params.includeSnapshot
      ? await snapshot(context, record, undefined, {
          modelAvailability: "current",
        })
      : undefined,
  };
}

export async function getTaskTokenUsage(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeTaskTokenUsageParamsSchema, rawParams ?? {});
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.queryTaskUsage) {
    return {
      sessionId: params.sessionId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    };
  }

  const usage = await usageStore.queryTaskUsage({
    sessionID: params.sessionId as SessionId,
  });
  return {
    sessionId: params.sessionId,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    modelRequestCount: usage.modelRequestCount,
    modelErrorCount: usage.modelErrorCount,
    inputBaselineBySource: usage.inputBaselineBySource,
  };
}
