import { resolveEffectiveBashShellSelection } from "@zcode/adapters/exec";
import {
  type ExecutionShellSelection,
  type MessageWithParts,
  type SessionId,
  type SessionTaskType,
  type TraceId,
  type WorkspaceId,
} from "@zcode/contracts";
import {
  subagentRuntimeConfigSchema,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  zcodeProtocolMethods,
  zcodeSessionRuntimePreferencesResultSchema,
  isRemoteWorkspaceIdentity,
  type AppToolSearchMode,
  type ZCodeSessionCreateParams,
  type IntegratedTerminalShellSelection,
  type ZCodeSessionRuntimePreferencesScope,
  type ZCodeSessionRuntimePreferencesResult,
  type ZCodeModelContextBudgetStrategy,
  type ZCodeProtocolTrace,
  type ZCodeSessionResumeParams,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import { buildWorkspaceRef } from "./mapper.js";
import {
  ProtocolRequestError,
  createProtocolRootTraceContext,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { createWorkspaceZCodeApp } from "./workspace-model-runtime.js";
import { createProtocolInteractionBroker } from "./interaction-broker.js";
import { createProtocolAutomationPort } from "./automation-port.js";
import { createProtocolOffPeakPort } from "./offpeak-port.js";
import { createProtocolTopicResourcePort } from "./topic-resource-port.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
import { resolveDynamicWorkflowRuntimeGate } from "./dynamic-workflow-policy.js";
import { toRuntimeModelSelection } from "./protocol-session-model.js";
import { onSessionEvent } from "./protocol-event-live.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
const REMOTE_AUTOMATION_TOOL_NAMES = [
  "CronCreate",
  "CronList",
  "CronUpdate",
  "CronDelete",
] as const;

type ZCodeSessionRecordParams = (
  | ZCodeSessionCreateParams
  | (ZCodeSessionResumeParams & {
      mode?: ZCodeSessionCreateParams["mode"];
      model?: ZCodeSessionCreateParams["model"];
      parentSessionId?: ZCodeSessionCreateParams["parentSessionId"];
      thoughtLevel?: ZCodeSessionCreateParams["thoughtLevel"];
      // 自动化会话会在创建期关闭标题二次生成，而 create/resume
      // 共用 record 初始化函数；resume 兼容分支也必须声明该策略字段。
      titleGenerationEnabled?: ZCodeSessionCreateParams["titleGenerationEnabled"];
    })
) & { taskType?: SessionTaskType };

interface SessionStartupPreferences {
  additionalDirectories?: readonly string[];
  subagentRuntimeConfigEnabled?: boolean;
  memoryEnabled: boolean;
  modelContextBudgetStrategy: ZCodeModelContextBudgetStrategy;
  nativeSearchEnhancementsEnabled: boolean;
  toolSearchMode: AppToolSearchMode;
  resolveInitialBashShellSelection: () => Promise<ExecutionShellSelection | undefined>;
}

type SessionStartupPreferencesSource =
  | { kind: "host" }
  | { kind: "inherit"; parent: ZCodeProtocolSessionRecord };

function resolveSessionToolDenylist(
  params: Pick<ZCodeSessionCreateParams, "toolDenylist">,
  workspace: ZCodeWorkspaceRef,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity)) {
    // Bug 原因：SSH/WSL/Docker/Server 等远程会话仍注入 automationPort，导致 Cron 工具在远端被注册；
    // 远程 workspace 没有本地调度器的可靠触发边界，所以必须在 session 初始化时统一禁用，
    // 不能只依赖 UI 或 prompt 文本约束。
    for (const toolName of REMOTE_AUTOMATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? [...tools] : undefined;
}

function integratedTerminalShellToExecutionSelection(
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection | undefined {
  if (!selection || selection.mode === "auto") {
    return undefined;
  }
  return {
    display: {
      name: selection.dialect === "git-bash" ? "Git Bash" : "CMD",
    },
    dialect: selection.dialect,
    id: selection.id,
    label: selection.label,
    path: selection.path,
    source: "user-config",
  };
}

function resolveProtocolBashShellSelection(
  context: ZCodeProtocolAgentServerContext,
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection {
  const configuredSelection = integratedTerminalShellToExecutionSelection(selection);
  return resolveEffectiveBashShellSelection({
    env: context.deps.env ?? process.env,
    override: configuredSelection,
    platform: context.deps.platform ?? process.platform,
  }).selection;
}

async function requestSessionRuntimePreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  scope: ZCodeSessionRuntimePreferencesScope,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeSessionRuntimePreferencesResult> {
  const startedAt = Date.now();
  // ZCodeProtocolTrace.traceId 是协议层的 string；LogContext 需要 branded TraceId，
  // 按本文件既有惯例断言收口，避免多处日志构造重复转换。
  const traceId = trace?.traceId as TraceId | undefined;
  context.logger?.debug("ZCode Protocol runtime preferences request started", {
    event: "zcode_protocol.runtime_preferences.request_started",
    module: "bootstrap.zcode_protocol",
    scope,
    sessionId,
    traceId,
  });
  try {
    const result = await context.requestClient(
      zcodeProtocolMethods.sessionRequestRuntimePreferences,
      { sessionId, scope },
      zcodeSessionRuntimePreferencesResultSchema,
      {
        timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        ...(trace ? { trace } : {}),
      },
    );
    context.logger?.debug("ZCode Protocol runtime preferences response received", {
      durationMs: Math.max(0, Date.now() - startedAt),
      event: "zcode_protocol.runtime_preferences.response_received",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    });
    return result;
  } catch (error) {
    const errorCode = error instanceof ProtocolRequestError ? error.code : undefined;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const diagnostic = {
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode,
      errorMessage,
      event: "zcode_protocol.runtime_preferences.request_failed",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    };
    if (errorCode === -32022) {
      // 诊断：偏好请求超时发生在 runtime 注册前；记录 session/scope，区分
      // “Host 没收到/没回包”和“恢复过程中其他阶段失败”。
      context.logger?.warn("ZCode Protocol runtime preferences request timed out", diagnostic);
    } else if (errorCode !== -32601 && errorCode !== -32020) {
      context.logger?.warn("ZCode Protocol runtime preferences request failed", diagnostic);
    } else {
      context.logger?.debug(
        "ZCode Protocol runtime preferences compatibility fallback",
        diagnostic,
      );
    }
    if (error instanceof ProtocolRequestError && (error.code === -32601 || error.code === -32020)) {
      // 兼容旧 Host 或无 Host 的纯 CLI 创建路径；Memory 服从产品默认关闭，
      // 增强搜索维持原有默认开启，其他协议/传输错误仍阻止 runtime 创建。
      return {
        askUserQuestionAutoResolutionEnabled: true,
        memoryEnabled: false,
        modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
        nativeSearchEnhancementsEnabled: true,
        toolSearchMode: "off",
      };
    }
    throw error;
  }
}

async function resolveSessionStartupPreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
): Promise<SessionStartupPreferences> {
  if (source.kind === "inherit") {
    const inheritedShellSelection = source.parent.app.runtime.getSessionShellSelection();
    return {
      memoryEnabled: source.parent.memoryEnabled,
      subagentRuntimeConfigEnabled: source.parent.subagentRuntimeConfigEnabled,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
      nativeSearchEnhancementsEnabled: source.parent.nativeSearchEnhancementsEnabled,
      toolSearchMode: source.parent.toolSearchMode,
      resolveInitialBashShellSelection: async () => inheritedShellSelection,
    };
  }

  const runtimePreferences = await requestSessionRuntimePreferences(
    context,
    sessionId,
    "runtime-materialization",
    trace,
  );
  // 必须在 session runtime 可发出第一次提问前应用；关闭路径会等待已有 snooze 持久化完成。
  await context.v4Interactions.initializeAskUserQuestionAutoResolutionEnabled(
    runtimePreferences.askUserQuestionAutoResolutionEnabled,
  );
  return {
    additionalDirectories: runtimePreferences.additionalDirectories,
    subagentRuntimeConfigEnabled: runtimePreferences.subagentRuntimeConfigEnabled,
    memoryEnabled: runtimePreferences.memoryEnabled,
    modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    nativeSearchEnhancementsEnabled: runtimePreferences.nativeSearchEnhancementsEnabled,
    toolSearchMode: runtimePreferences.toolSearchMode,
    resolveInitialBashShellSelection: async () => {
      const executionPreferences = await requestSessionRuntimePreferences(
        context,
        sessionId,
        "user-execution",
        trace,
      );
      return resolveProtocolBashShellSelection(
        context,
        executionPreferences.integratedTerminalShell,
      );
    },
  };
}

export async function materializeSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  const startupPreferences = await resolveSessionStartupPreferences(
    context,
    sessionId,
    source,
    trace,
  );
  return createRecord(context, params, sessionId, resume, startupPreferences, trace);
}

async function createRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  startupPreferences: SessionStartupPreferences,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  const workspace =
    "workspace" in params && params.workspace
      ? params.workspace
      : buildWorkspaceRef({ workspacePath: context.deps.cwd ?? process.cwd() });
  const eventStore = context.deps.createSessionEventStore(sessionId);
  const traceContext = createProtocolRootTraceContext(sessionId, trace);
  const initialModel = "model" in params ? params.model : undefined;
  const parentSessionId =
    "parentSessionId" in params && params.parentSessionId
      ? (params.parentSessionId as SessionId)
      : undefined;
  const taskType = params.taskType ?? "interactive";
  const runtimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  context.logger?.info("ZCode Protocol createRecord MCP config", {
    event: "zcode_protocol.create_record.mcp_config",
    rootTraceId: traceContext.traceId,
    inboundTraceId: trace?.traceId,
    paramMcpServerCount: params.mcpServers?.length ?? 0,
    runtimeHasMcpConfig: Boolean(runtimeMcp),
    runtimeMcpServerCount: Object.keys(runtimeMcp?.servers ?? {}).length,
    sessionId,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  // automation-port 需要读取「本会话」的实时 model/mode/thought；record 在 app 之后才建。
  // 用可变持有者做惰性绑定：CronCreate 在 turn 中调用 create() 时 record 早已就绪。
  let ownSessionRecord: ZCodeProtocolSessionRecord | undefined;
  const app = await createWorkspaceZCodeApp(context, workspace, {
    env: context.deps.env,
    eventStore,
    resume,
    additionalDirectories: params.additionalDirectories ?? startupPreferences.additionalDirectories,
    runtimeConfig: {
      mode: "mode" in params ? params.mode : undefined,
      modelSelection: "model" in params ? toRuntimeModelSelection(initialModel) : undefined,
      parentSessionId,
      taskType,
      // 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」「On demand: activation」）：
      // 与 offPeakPort 同一套读法——本次 create/resume 参数优先，缺席时读 Host 同步到进程的
      // workspace 级结论。取值与「必须显式布尔」的理由收在 resolveDynamicWorkflowRuntimeGate。
      ...resolveDynamicWorkflowRuntimeGate(
        {
          dynamicWorkflowEnabled:
            "dynamicWorkflowEnabled" in params ? params.dynamicWorkflowEnabled : undefined,
          dynamicWorkflowMode:
            "dynamicWorkflowMode" in params ? params.dynamicWorkflowMode : undefined,
        },
        context.appRuntimePreferences,
      ),
      // 修复原因：协议侧的工具允许/拒绝列表是 session 级安全边界，必须进入 runtimeConfig，
      // 不能只依赖 prompt 文本约束，否则内置工具和动态 MCP 工具仍可能越过调用面。
      toolAllowlist: "toolAllowlist" in params ? params.toolAllowlist : undefined,
      toolDisallowlist: resolveSessionToolDenylist(params, workspace),
      nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
      toolSearch: { mode: startupPreferences.toolSearchMode },
      modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
      // Memory Settings 是现有 CLI features.memory/use 之外的总开关。只在关闭时
      // 写入 override，避免开启值反向覆盖用户已有的 CLI 禁用配置。
      ...(startupPreferences.memoryEnabled ? {} : { memory: { enabled: false } }),
      // desktop-continuous session/create 由 UI 先解析 ~/.zcode/.agents 的 enabled MCP，
      // 但 protocol app-server 自己不会读取 UI/main 侧的 MCP store；之前 createRecord 没把
      // params.mcpServers 注入 runtimeConfig，导致日志里 runtimeHasMcpConfig=false，工具永远不启动。
      // MCP 是 runtime 启动期配置，因此必须在 session 创建/恢复边界一次性写入 runtimeConfig.mcp。
      ...(runtimeMcp ? { mcp: runtimeMcp } : {}),
      // 之前只有 TUI 路径（tui-prompt-handler）注入 titleGeneration，
      // ZCode Protocol app-server 创建的 session（desktop/web/mobile）没有传，导致
      // shouldAttemptSessionTitleGeneration 的 `if (!config.titleGeneration) return false`
      // 永远命中，模型生成 title 的请求从不触发，侧边栏标题一直停在 first_input 的用户 query。
      // 这里补一份默认配置开启；具体是否生成仍由 runtime 按 parent/taskType/turnNumber 把关。
      // automation 执行会话显式关闭二次命名，避免回答内容覆盖原始用户 query 标题。
      titleGeneration: params.titleGenerationEnabled === false ? { enabled: false } : {},
      workingDirectory: workspace.workspacePath,
      // 身份隔离与路径执行分开：core 只把 identity 写入 session.workspace_id，
      // workingDirectory 仍是远端机器上的实际路径；本地 workspace 保持 undefined。
      workspaceIdentity: workspace.workspaceIdentity as WorkspaceId | undefined,
    },
    // ZCode Protocol app-server 以前没有注入可等待的交互 broker，
    // core 遇到 permission / AskUserQuestion 只能走默认拒绝，UI 永远收不到阻塞请求。
    // 这里把阻塞交互转换成 server-to-client JSON-RPC request，由 app 通过 response 释放 runtime。
    permissionBroker: createProtocolInteractionBroker(context),
    automationPort: createProtocolAutomationPort(context, () => ownSessionRecord),
    topicResourcePort: createProtocolTopicResourcePort(context),
    // 只接入 Host 已开放的工具面；缺省不注入。复用现行异步工厂，
    // 不恢复旧 deferred ModelAdapter/Registry overlay，也不改变 Session Selection。
    ...(("offPeakToolEnabled" in params && params.offPeakToolEnabled === true) ||
    context.appRuntimePreferences.offPeakToolEnabled === true
      ? { offPeakPort: createProtocolOffPeakPort(context, () => ownSessionRecord) }
      : {}),
    resolveInitialBashShellSelection: startupPreferences.resolveInitialBashShellSelection,
    ...(startupPreferences.subagentRuntimeConfigEnabled &&
    !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
      ? {
          readSubagentRuntimeConfig: async ({ signal, traceContext }) => {
            signal.throwIfAborted();
            const result = await context.requestClient(
              zcodeProtocolMethods.subagentsReadRuntimeConfig,
              { sessionId },
              subagentRuntimeConfigSchema,
              {
                signal,
                timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
                trace: { traceId: traceContext.traceId },
              },
            );
            signal.throwIfAborted();
            return result;
          },
        }
      : {}),
    // browser-use：agent.browsers.* 经此把命令转成 interaction/browserExecute 反向请求。
    browserControlPort: createProtocolBrowserControlBroker(context),
    // Protocol server 是受信任的 Desktop/Web/Mobile Host；灰度开关由这里显式注入，
    // 不从 workspace/project 配置或环境变量读取，关闭时仍可通过删掉该字段回滚到 hard block。
    workspaceHookTrustEnabled: true,
    // 无 session 的 Settings Trust 曾绕过 managed policy；session Runtime 与
    // workspace RPC 必须共享 Host 持有的同一 provider，不能各自创建默认 policy。
    workspaceHookPolicyProvider: context.deps.workspaceHookPolicyProvider,
    workspaceHookReviewHost: {
      taskId: sessionId,
      runId: `workspace-hook-run:${sessionId}:${crypto.randomUUID()}`,
      workspaceLabel:
        workspace.workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace.workspacePath,
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
    },
    sessionId,
    sessionStore: context.deps.sessionStore,
    traceContext,
    version: context.deps.version,
    modelIoFullRetentionEnabled: context.appRuntimePreferences.modelIoFullRetentionEnabled,
  });
  const now = Date.now();
  const record: ZCodeProtocolSessionRecord = {
    app,
    createdAt: now,
    eventStore,
    memoryEnabled: startupPreferences.memoryEnabled,
    subagentRuntimeConfigEnabled: startupPreferences.subagentRuntimeConfigEnabled,
    modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
    nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
    toolSearchMode: startupPreferences.toolSearchMode,
    ...(parentSessionId ? { parentSessionId } : {}),
    persistence: "persistence" in params ? (params.persistence ?? "immediate") : "immediate",
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    taskType,
    traceContext,
    updatedAt: now,
    workspace,
  };
  const unsubscribeSessionEvents = app.runtime.subscribeEvents({
    onSessionEvent: (event) => onSessionEvent(context, record, event),
  });
  record.unsubscribe = () => {
    unsubscribeSessionEvents();
  };
  // 绑定归属会话，供 automation-port 读取本会话实时 model/mode/thought。
  ownSessionRecord = record;
  return record;
}

export async function readPersistedSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<MessageWithParts[]> {
  return await (context.deps.sessionStore?.messages({
    sessionID: sessionId as SessionId,
  }) ?? []);
}

export function derivePersistedSessionMode(
  messages: readonly MessageWithParts[],
): ZCodeSessionCreateParams["mode"] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role === "assistant" && isZCodeSessionMode(info.mode)) return info.mode;
  }
  return undefined;
}

function isZCodeSessionMode(
  value: unknown,
): value is NonNullable<ZCodeSessionCreateParams["mode"]> {
  return (
    value === "plan" ||
    value === "build" ||
    value === "edit" ||
    value === "yolo" ||
    value === "guarded" ||
    value === "auto"
  );
}
