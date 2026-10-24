import type { SessionId } from "@zcode/contracts";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import { cloneModelSelection } from "./fork-model-selection.js";
import { resolveWorkspaceRefFromId } from "./mapper.js";
import { createSessionRecordForV4 } from "./protocol-session-lifecycle.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import { registerCommittedForkBestEffort } from "./v4-bridge-fork-commit.js";

// v4 网关 binder。
// 定位：ConversationV4Gateway 是域无关的通道运行时，本文件把它绑到协议服务器上下文：
// - 帧出口 = context.notify（stdio NDJSON notification，与旧 session/event 同一条管道并存）；
// - 命令执行 = V4CommandExecutor（zcode-protocol-v4/commands/，原生直驱 core）；
//   20 命令全部原生，supports() 未命中（未知命令）→ notImplemented。
// - 过渡钩子（ensureModelReady / afterLegacyStateMutation / closeSession /
//   createSessionRecord / child record registration / resumePersistedSession）在此注入旧协议实现，随旧协议一同删除。
//
// 不做桥接：依赖方向只允许 旧目录 → v4 目录。
// 本文件在旧目录，import v4 executor 合法；v4 目录禁止反向 import 本目录任何模块。

export function createV4SessionCreationHost(
  context: ZCodeProtocolAgentServerContext,
  queuedTurnExecutions: Pick<Map<string, unknown>, "delete">,
) {
  return {
    // 删除先由会话存储提交软删除事实，再释放同一个原生运行载体。
    deleteSession: async (sessionId) => {
      if (!context.deps.sessionStore?.softDeleteSession)
        throw new Error("Session soft deletion is unavailable");
      await context.deps.sessionStore.softDeleteSession(sessionId as SessionId);
      const record = context.sessions.get(sessionId);
      if (!record) {
        // handler 已校验存在性；此处只兜并发竞态（重复删除幂等成功）。
        return;
      }
      record.unsubscribe?.();
      await record.app.close?.();
      // v4 通道：会话关闭同时清 publisher / 订阅调度；重开会话走 snapshot 冷启动。
      // disposeSession 必须在注册表删除之前调用——
      // gateway 靠 getSessionWorkspaceId（读 context.sessions）定位 workspace 才能把
      // session.removed 推给 sessions-index 订阅者；先 delete 再 dispose 时 workspaceId
      // 恒为 null，删除会话后侧栏列表项永不消失（e2e conversation-session-v4-sidebar 抓出）。
      context.v4Gateway?.disposeSession(sessionId, { deleted: true });
      queuedTurnExecutions.delete(sessionId);
      context.sessions.delete(sessionId);
    },
    // createSession 的执行面：record 建立/事件接线/catalog 同步/失败自清理全在旧
    // createSession op 内（半初始化 record 的回收顺序修过 bug，不重复实现）。
    // 语义决策（draft persistence / firstInput 走原生 prompt turn）在原生 handler。
    createSessionRecord: async ({
      sessionId,
      additionalDirectories,
      workspaceId,
      mcpServers,
      offPeakToolEnabled,
      dynamicWorkflowEnabled,
      dynamicWorkflowMode,
      permissionScope,
    }) => {
      if (permissionScope && !context.deps.sessionStore)
        throw new Error("Group task permission scope requires persistence");
      // workspaceId 双形态（Workspace Identity 约束）：
      // - 本地工作区 = workspacePath（identity 缺省时的 fallback）；
      // - 远程 pane（跨 workspace 分屏）= 远程 identity
      //   （remote:ssh/wsl/docker:...:<path>，UI buildRemoteWorkspaceIdentity 构造）。
      //   经统一解析工具还原真实 workspacePath 作 workingDirectory——CLI 本就跑在
      //   远端机器上，path 即本机路径；identity 原样保留进 workspace ref
      //   （workspaceKey = identity，sessions-index topic / 隔离语义不变）。
      // shared parser 统一兼容 WSL legacy 与显式 user identity；非远程格式继续按
      // 本地 workspacePath 处理。
      const created = await createSessionRecordForV4(context, {
        sessionId,
        additionalDirectories,
        workspace: resolveWorkspaceRefFromId(workspaceId),
        // 群任务已经由首条真实需求触发，先落盘隔离授权，再开放任务与配置。
        // 普通 Desktop draft 仍保持 deferred。
        persistence: "deferred",
        // MCP 是 runtime 创建期配置；v4 createSession 必须与 legacy
        // session/create 等价透传，否则创建的 session 永远不会启动这些工具。
        mcpServers,
        // Off-Peak 工具面 flag 同为 runtime 创建期配置，必须随 create 进入 record。
        ...(offPeakToolEnabled === true ? { offPeakToolEnabled: true } : {}),
        // 动态工作流灰度门同为 runtime 创建期配置：
        // v4 createSession 必须与 legacy session/create 等价透传，否则无界面创建的会话
        // 会绕过 Host 的灰度判定，只剩进程级缺省。
        ...(dynamicWorkflowEnabled === true ? { dynamicWorkflowEnabled: true } : {}),
        ...(dynamicWorkflowEnabled === true && dynamicWorkflowMode !== undefined
          ? { dynamicWorkflowMode }
          : {}),
      });
      if (permissionScope) {
        const record = context.sessions.get(created.sessionId);
        if (!record) throw new Error("Group task runtime is unavailable");
        await record.app.runtime.ensureSessionPersistedForExternalActivity("", {
          traceContext: record.traceContext,
        });
        await context.deps.sessionStore!.updateSession({
          id: created.sessionId as SessionId,
          permission: { version: 1, scope: "session", mode: "build" },
        });
        await record.app.runtime.setExecutionState({ mode: "build" }, record.traceContext);
        record.persistence = "immediate";
      }
      return { sessionId: created.sessionId };
    },
    createSelectionSideSession: async (sessionId, options) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const modelSelection = cloneModelSelection(
        options.modelSelection ?? record.app.runtime.getSessionModelSelection(),
      );
      const fork = await record.app.runtime.createSelectionSideConversation({
        modelSelection,
        sourceCommandId: options.sourceCommandId,
        revisionAtDecision: options.revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: options.sourceCommandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
          followupMode: context.v4Gateway?.getSessionFollowupMode(sessionId) ?? "queue",
        },
        inheritLatestTarget: false,
      });
      return { sessionId: String(fork.forkedSessionId) };
    },
  } satisfies Partial<V4CommandCoreHost>;
}
