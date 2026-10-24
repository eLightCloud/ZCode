import {
  CoreErrorType,
  createSessionId,
  createCoreError,
  type MessageWithParts,
  type SessionId,
  type SessionInfo,
  type WorkspaceId,
} from "@zcode/contracts";
import {
  zcodeProtocolErrorCodes,
  zcodeSessionCloseParamsSchema,
  zcodeSessionCreateParamsSchema,
  zcodeSessionResumeParamsSchema,
  parseRemoteWorkspaceIdentity,
  type ZCodeProtocolTrace,
  type ZCodeSessionResumeParams,
  type ZCodeSessionPersistence,
} from "@zcode/shared";
import { buildWorkspaceRef, formatProtocolModelSelection } from "./mapper.js";
import {
  ProtocolRequestError,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { projectIdFromDirectory } from "../app/paths.js";
import { runSessionModelConfigMutation } from "../zcode-protocol-v4/model-config-mutation.js";
import { abortMcpUiToolCallsForSession, clearMcpUiAppToolsForSession } from "./mcp-ui/index.js";
import {
  snapshotWithDiagnostics,
  type SnapshotPhaseDurationsMs,
  getPersistedSession,
  snapshot,
} from "./protocol-session-snapshot.js";
import {
  materializeSessionRecord,
  readPersistedSessionMessages,
  derivePersistedSessionMode,
} from "./protocol-session-record.js";
import { resolveSupportedAppThoughtLevel } from "./protocol-session-model.js";
import { persistImportedSessionHistory } from "./protocol-history-import.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
export async function createSession(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace?: ZCodeProtocolTrace,
) {
  return createSessionWithProjection(context, rawParams, trace, async (record) => {
    const result = await snapshotWithDiagnostics(context, record);
    return {
      value: result.snapshot,
      phaseDurationsMs: result.phaseDurationsMs,
      messageCount: result.snapshot.messages.length,
    };
  });
}

/** V4 创建只需要 record；不要为了丢弃的 legacy snapshot 强制解析空模型。 */
export async function createSessionRecordForV4(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return createSessionWithProjection(context, rawParams, undefined, async (record) => ({
    value: { sessionId: record.app.sessionId },
  }));
}

async function createSessionWithProjection<T>(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace: ZCodeProtocolTrace | undefined,
  project: (
    record: ZCodeProtocolSessionRecord,
  ) => Promise<{ value: T; phaseDurationsMs?: SnapshotPhaseDurationsMs; messageCount?: number }>,
): Promise<T> {
  const params = parseParams(zcodeSessionCreateParamsSchema, rawParams);
  const sessionId = (params.sessionId ?? createSessionId()) as SessionId;
  const claims = (context.sessionCreationIds ??= new Set<string>());
  // Host 预留只决定身份与归属，不能覆盖 CLI 已有/软删/正在创建的会话。
  // 在任何 await 前占用 ID，防止 native 与 V4 并发 materialize 同一 runtime。
  if (context.sessions.has(sessionId) || claims.has(sessionId))
    throw new ProtocolRequestError(-32602, "sessionId already exists");
  claims.add(sessionId);
  try {
    if (await context.deps.sessionStore?.getSession(sessionId))
      throw new ProtocolRequestError(-32602, "sessionId already exists");
    return await materializeCreatedSession(context, { ...params, sessionId }, trace, project);
  } finally {
    claims.delete(sessionId);
  }
}

async function materializeCreatedSession<T>(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace: ZCodeProtocolTrace | undefined,
  project: (
    record: ZCodeProtocolSessionRecord,
  ) => Promise<{ value: T; phaseDurationsMs?: SnapshotPhaseDurationsMs; messageCount?: number }>,
): Promise<T> {
  const params = parseParams(zcodeSessionCreateParamsSchema, rawParams);
  const startedAt = Date.now();
  const sessionId = params.sessionId! as SessionId;
  const workspace = params.workspace;
  context.logger?.info("ZCode Protocol session/create started", {
    event: "zcode_protocol.session_create.started",
    hasInitialModel: params.model !== undefined,
    hasInitialThoughtLevel: params.thoughtLevel !== undefined,
    inboundTraceId: trace?.traceId,
    module: "bootstrap.zcode_protocol",
    persistence: params.persistence,
    sessionId,
    status: "started",
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  const recordStartedAt = Date.now();
  const record = await materializeSessionRecord(
    context,
    { ...params, workspace },
    sessionId,
    false,
    { kind: "host" },
    trace,
  );
  const recordCreateDurationMs = Date.now() - recordStartedAt;
  context.assertServing?.();
  context.sessions.set(sessionId, record);
  let setInitialModelDurationMs: number | undefined;
  let setInitialThoughtLevelDurationMs: number | undefined;
  let snapshotDurationMs = 0;
  let snapshotPhaseDurationsMs: SnapshotPhaseDurationsMs | undefined;
  const initialModel = params.model;
  const initialThoughtLevel = params.thoughtLevel;
  try {
    await runSessionModelConfigMutation(record.app, async () => {
      if (initialModel) {
        const setInitialModelStartedAt = Date.now();
        await record.app.setModel(formatProtocolModelSelection(initialModel));
        setInitialModelDurationMs = Date.now() - setInitialModelStartedAt;
        record.stateRevision++;
      }
      const supportedInitialThoughtLevel = resolveSupportedAppThoughtLevel(
        record.app,
        initialThoughtLevel,
      );
      if (supportedInitialThoughtLevel) {
        // app 已接管默认模型/思考深度持久化，session/create 会显式传入 thoughtLevel。
        // Workspace Preferences 必须持久化读取：只读 Agent 内存会在重启后丢掉用户上次选择。
        const setInitialThoughtLevelStartedAt = Date.now();
        await record.app.setThoughtLevel(supportedInitialThoughtLevel);
        setInitialThoughtLevelDurationMs = Date.now() - setInitialThoughtLevelStartedAt;
        record.stateRevision++;
      } else if (initialThoughtLevel) {
        // workspace 默认 thoughtLevel 可能来自上一个模型。新 session 继承另一模型时，
        // 不能把不支持的档位硬塞给 runtime，否则创建阶段会抛 Unsupported reasoning effort。
        context.logger?.warn("ZCode Protocol session/create skipped unsupported thought level", {
          event: "zcode_protocol.session_create.thought_level_skipped",
          module: "bootstrap.zcode_protocol",
          requestedThoughtLevel: initialThoughtLevel,
          sessionId,
          supportedThoughtLevels: record.app.listThoughtLevels(),
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.workspacePath,
        });
      }
    });
    if (params.importedHistory) {
      // 历史导入过去只写 legacy snapshot，taskId 不是真实 protocol sessionId，
      // setModel/sendPrompt 会打到不存在的 runtime。这里在创建期把历史写入 sessionStore 并 resume，
      // 让导入结果从第一刻起就是可续聊、可切模型的 ZCode session。
      await persistImportedSessionHistory({
        context,
        record,
        sessionId,
        createParams: params,
      });
      await record.app.resume();
      record.stateRevision++;
    }
    const snapshotStartedAt = Date.now();
    const createdSnapshotResult = await project(record);
    const createdSnapshot = createdSnapshotResult.value;
    snapshotPhaseDurationsMs = createdSnapshotResult.phaseDurationsMs;
    snapshotDurationMs = Date.now() - snapshotStartedAt;
    context.logger?.info("ZCode Protocol session/create completed", {
      durationMs: Date.now() - startedAt,
      event: "zcode_protocol.session_create.completed",
      hasInitialModel: initialModel !== undefined,
      hasInitialThoughtLevel: initialThoughtLevel !== undefined,
      messageCount: createdSnapshotResult.messageCount,
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "completed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    return createdSnapshot;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/create failed", {
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.session_create.failed",
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "failed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    // draft 创建会用用户上次选择的模型作为启动种子。
    // 如果该模型已被删除，失败的 record 不能留在 context.sessions：
    // 后续 workspace 状态继续读到这个半初始化 app，造成模型/思考档位串台。
    record.unsubscribe?.();
    // v4 通道：创建期已 ingest 的事件会惰性建出 publisher，失败清理时一并回收。
    // 创建失败只释放运行态，不把它宣告为 CLI 已持久化的软删除。
    context.v4Gateway?.disposeSession(sessionId);
    context.sessions.delete(sessionId);
    try {
      await record.app.close?.();
    } catch {
      // 保留原始 create 失败原因；close 只是清理半初始化 runtime 的 best-effort 动作。
    }
    // 内存 event store 随 record 释放。
    await record.eventStore.deleteSession(sessionId as SessionId).catch(() => undefined);
    throw error;
  }
}

export interface ActivatedSessionForResume {
  record: ZCodeProtocolSessionRecord;
  knownSession?: SessionInfo;
  /** 仅供启动本次 V4 hydration，不写入 record 或跨请求缓存。 */
  persistedMessages?: MessageWithParts[];
}

/** 只拆掉本次失败的 record；不删除持久历史或 gateway publisher。 */
export async function discardFailedSessionResume(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  record: ZCodeProtocolSessionRecord,
): Promise<void> {
  if (context.sessions.get(sessionId) !== record) return;
  record.unsubscribe?.();
  context.sessions.delete(sessionId);
  try {
    await record.app.close?.();
  } catch {
    /* 保留原始恢复错误。 */
  }
  await record.eventStore.deleteSession(sessionId as SessionId).catch(() => undefined);
}

/**
 * 只恢复 session runtime 生命周期，不物化任何协议表示。
 *
 * V4 冷订阅过去复用 resumeSession，虽然返回值会被直接丢弃，仍会为大历史
 * 构建一份完整 legacy snapshot。runtime 激活和 legacy 表示是两个职责；这里保留
 * snapshot 之前的原有顺序与副作用，让 V4 随后用自己的 durable projection 水合。
 */
export async function activateSessionForResume(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionResumeParams,
  options: { reusePersistedMessages?: boolean; persistedMessages?: MessageWithParts[] } = {},
): Promise<ActivatedSessionForResume> {
  const resumeStartedAt = Date.now();
  const activeBeforeWait = context.sessions.has(params.sessionId);
  context.logger?.debug("ZCode Protocol session resume started", {
    activeBeforeWait,
    event: "zcode_protocol.session.resume_started",
    hasSessionStore: Boolean(context.deps.sessionStore),
    module: "bootstrap.zcode_protocol",
    sessionId: params.sessionId,
  });
  // 再激活闸门：该 session 正在容量去激活（app.close 收尾未完成）时先等待，
  // 防止新旧 app 对同一 session 资源交错读写。无 in-flight 时立即返回。
  await context.sessionResidentPool?.waitForDeactivation(params.sessionId);
  const existing = context.sessions.get(params.sessionId);
  if (existing) {
    return { record: existing };
  }
  let session = await getPersistedSession(context, params.sessionId);
  if (!session || session.time.deleted !== undefined) {
    // 诊断：冷恢复只有在持久化记录也不存在时才会走到这里；单凭错误文本无法和
    // readSession 的“runtime 尚未活跃”区分，因此把两层状态和等待耗时一起落盘。
    context.logger?.warn("ZCode Protocol session resume found no persisted record", {
      activeBeforeWait,
      activeSessionCount: context.sessions.size,
      durationMs: Math.max(0, Date.now() - resumeStartedAt),
      event: "zcode_protocol.session.resume_persisted_missing",
      hasSessionStore: Boolean(context.deps.sessionStore),
      module: "bootstrap.zcode_protocol",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  session = await repairLegacyRemoteSessionWorkspaceForResume(context, session);
  const workspace =
    params.workspace ??
    buildWorkspaceRef({
      // V4 历史会话冷订阅只传 sessionId；远端会话若在这里仅用目录
      // 重建 workspace，identity 会退化成 path key，无法命中按 workspaceID 隔离的
      // provider registry，最终把可用模型误判为不可用并永久触发 restoreWarning。
      workspaceIdentity: session.workspaceID,
      workspacePath: session.path ?? session.directory,
    });
  let persistedMessages =
    options.persistedMessages ?? (await readPersistedSessionMessages(context, params.sessionId));
  const mode = derivePersistedSessionMode(persistedMessages);
  // shell 设置变更只对新 session 生效；冷恢复必须使用创建时落库的
  // Bash shell 快照。runtime.resumeFromStore 会读取快照；这里只负责不把
  // resume 请求里携带的当前 settings 重新注入老 session。
  const record = await materializeSessionRecord(
    context,
    {
      ...params,
      mode,
      // 模型只由 App 的单向迁移/当前 entry 恢复，不能先用消息或调用方 hint 构造一次选择。
      model: undefined,
      ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
      // resume 曾丢掉持久化 taskType，createRecord 落回缺省
      // "interactive"。于是被 resume 的 workflow_child / subagent_child 会话通过
      // isTaskListSessionType 的筛，经 getSessionWorkspaceId 漏进 sessions-index，
      // desktop 任务列表长出「workflow actor actor#N@k」假任务，任务索引同步器还会
      // 反复对它们发 session/resume。fork 路径一直带着 taskType，这里必须同样带。
      taskType: session.taskType,
      workspace,
    },
    params.sessionId as SessionId,
    true,
    { kind: "host" },
    session.traceID ? { traceId: session.traceID } : undefined,
  );
  // createRecord 把 createdAt/updatedAt 写死为 Date.now()——resume 老会话
  // 会让 sessions-index 把它当"刚创建"的会话（配合 hydration 前的空标题，侧栏
  // 表现为原会话消失、冒出"新任务刚刚"）。恢复路径回填 store 的真实时间。
  if (session.time?.created) record.createdAt = session.time.created;
  if (session.time?.updated) record.updatedAt = session.time.updated;
  record.lastOutcome = session.lastOutcome;
  context.assertServing?.();
  context.sessions.set(params.sessionId, record);
  try {
    const resumeResult = await runSessionModelConfigMutation(record.app, async () => {
      const result = options.reusePersistedMessages
        ? await record.app.resume({ persistedMessages })
        : await record.app.resume();
      // 仅用于首次投影种子，包含有效模型+空档位；它不是第二份可执行 Runtime 选择。
      record.restoredModelSelection = result.modelSelection;
      return result;
    });
    if (options.reusePersistedMessages && resumeResult.persistedMessagesReloadRequired) {
      persistedMessages = await readPersistedSessionMessages(context, params.sessionId);
    }
    context.logger?.info("ZCode Protocol session resume completed", {
      activeSessionCount: context.sessions.size,
      durationMs: Math.max(0, Date.now() - resumeStartedAt),
      event: "zcode_protocol.session.resume_completed",
      module: "bootstrap.zcode_protocol",
      persistedMessageCount: persistedMessages.length,
      sessionId: params.sessionId,
      traceId: record.traceContext.traceId,
    });
    return {
      knownSession: session,
      record,
      ...(options.reusePersistedMessages ? { persistedMessages } : {}),
    };
  } catch (error) {
    // resume 入册后失败曾留下半初始化 app，重试误判已就绪；只回收本次 record，保留历史投影。
    await discardFailedSessionResume(context, params.sessionId, record);
    throw error;
  }
}

export async function resumeSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionResumeParamsSchema, rawParams);
  const activated = await activateSessionForResume(context, params);
  return await snapshot(context, activated.record, activated.knownSession);
}

async function repairLegacyRemoteSessionWorkspaceForResume(
  context: ZCodeProtocolAgentServerContext,
  session: SessionInfo,
): Promise<SessionInfo> {
  if (session.workspaceID || !context.deps.sessionStore?.repairLegacyRemoteSessionWorkspace) {
    return session;
  }
  const legacyWorkspaceDirectory = session.path ?? session.directory;
  if (session.directory !== legacyWorkspaceDirectory) return session;
  const legacyRemote = resolveLegacyRemoteWorkspace(context, legacyWorkspaceDirectory);
  if (!legacyRemote) return session;

  const repaired = await context.deps.sessionStore.repairLegacyRemoteSessionWorkspace({
    sessionID: session.id,
    projectID: projectIdFromDirectory(legacyRemote.workspacePath),
    legacyWorkspaceDirectory,
    workspaceID: legacyRemote.workspaceIdentity,
    workspacePath: legacyRemote.workspacePath,
  });
  // 原子修复返回 false 后仍用旧 directory/path 物化 runtime，最终在错误 cwd
  // 中执行工具。这里必须读取原始持久事实，不能让已有 identity 的内存路径修复伪装成已落盘。
  const refreshed = await context.deps.sessionStore.getSession(session.id);
  const repairPersisted =
    refreshed?.workspaceID === legacyRemote.workspaceIdentity &&
    refreshed.directory === legacyRemote.workspacePath &&
    refreshed.path === legacyRemote.workspacePath;
  if (!repairPersisted) {
    context.logger?.warn("legacy remote session workspace repair was not persisted", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repair_rejected",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      repaired,
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Legacy remote session workspace repair was not persisted",
      {
        context: {
          directory: refreshed?.directory ?? session.directory,
          path: refreshed?.path ?? session.path,
          reason: "legacy_remote_session_workspace_repair_rejected",
          sessionId: session.id,
          workspaceIdentity: legacyRemote.workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }
  if (repaired) {
    context.logger?.info("legacy remote session workspace repaired", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repaired",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
  }
  // Core resumeFromStore 会重新读库；NULL identity 修复必须先持久化，不能只改 bootstrap 内存值。
  return refreshed;
}

function resolveLegacyRemoteWorkspace(
  context: ZCodeProtocolAgentServerContext,
  legacyWorkspaceDirectory: string,
): { workspaceIdentity: WorkspaceId; workspacePath: string } | null {
  const currentWorkspacePath = context.deps.cwd ?? process.cwd();
  const direct = parseRemoteWorkspaceIdentity(legacyWorkspaceDirectory);
  if (direct?.kind === "wsl" && direct.workspacePath === currentWorkspacePath) {
    return {
      workspaceIdentity: legacyWorkspaceDirectory as WorkspaceId,
      workspacePath: direct.workspacePath,
    };
  }

  const identityPrefix = currentWorkspacePath === "/" ? "/" : `${currentWorkspacePath}/`;
  if (!legacyWorkspaceDirectory.startsWith(identityPrefix)) return null;
  const embeddedIdentity = legacyWorkspaceDirectory.slice(identityPrefix.length);
  const embedded = parseRemoteWorkspaceIdentity(embeddedIdentity);
  if (
    embedded?.kind !== "wsl" ||
    `${identityPrefix}${embeddedIdentity}` !== legacyWorkspaceDirectory ||
    embedded.workspacePath !== currentWorkspacePath
  ) {
    return null;
  }

  // 只接受当前 app-server cwd 直接拼出的精确形态，不在任意路径中模糊搜索 remote: 前缀。
  return {
    workspaceIdentity: embeddedIdentity as WorkspaceId,
    workspacePath: embedded.workspacePath,
  };
}

export async function closeSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionCloseParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  if (!shouldCloseSessionForExpectedPersistence(record.persistence, params.expectedPersistence)) {
    // 连接切换与跨端首发可能并发。session/send 会先把 deferred 提升为
    // immediate；条件关闭必须在 Agent record 上原子判断，不能依赖 renderer 的旧快照。
    return { closed: false };
  }
  record.unsubscribe?.();
  // 会话关闭时 abort 仍在进行的插件 UI 工具调用，登记表不留孤儿。
  abortMcpUiToolCallsForSession(params.sessionId);
  // App-Provided Tools：结束本会话全部待执行的页面调用并丢弃登记。
  clearMcpUiAppToolsForSession(context, params.sessionId);
  // 清掉本会话全部资源订阅（refcount 归零的 uri 才真正向 server 退订）。
  await record.app.unsubscribeMcpResourcesForUi?.(`${params.sessionId}|`).catch(() => 0);
  await record.app.close?.();
  // v4 通道（M3）：会话关闭同时清 publisher / 订阅调度；重开会话走 snapshot 冷启动。
  // 关闭运行实例不删除持久化事实，因此必须保留 sessions-index 中的行。
  context.v4Gateway?.disposeSession(params.sessionId);
  context.sessions.delete(params.sessionId);
  // 内存 event store 随 record 释放。
  await record.eventStore.deleteSession(params.sessionId as SessionId);
  return { closed: true };
}

export function shouldCloseSessionForExpectedPersistence(
  currentPersistence: ZCodeSessionPersistence,
  expectedPersistence?: ZCodeSessionPersistence,
): boolean {
  return expectedPersistence === undefined || currentPersistence === expectedPersistence;
}
