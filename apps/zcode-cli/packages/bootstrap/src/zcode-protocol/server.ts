import type { ZCodeProtocolAgentServerApi } from "./protocol-server-api.js";
import type * as implementation5 from "./protocol-server-client-requests.js";
import type * as implementation3 from "./protocol-server-dispatch.js";
import type * as implementation2 from "./protocol-server-messages.js";
import { installZCodeProtocolAgentServerMethods } from "./protocol-server-methods.js";
import type * as implementation4 from "./protocol-server-operation-signals.js";
import { createNodeNetworkCapture } from "@zcode/shared/node";
import { zcodeProtocolNotifications } from "@zcode/shared";
import type { BrowserControlPort } from "@zcode/contracts";
import { InMemoryWorkspaceHookPolicyProvider } from "@zcode/core";
import type { ZCodeProtocolMethod } from "@zcode/shared";
import type { ZCodeProtocolRequest } from "@zcode/shared";
import type { ZCodeProtocolRequestId } from "@zcode/shared";
import { ProtocolRuntimeResources } from "./runtime-resources.js";
import { V4InteractionRegistry } from "../zcode-protocol-v4/interaction-registry.js";
import { resolveV4InteractionRegistryOptionsFromEnv } from "../zcode-protocol-v4/interaction-registry.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { createSessionResidentPoolHost } from "./session-residency.js";
import { DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT } from "./session-resident-pool.js";
import { SessionResidentPool } from "./session-resident-pool.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import { PROTOCOL_CLIENT_REQUEST_ERROR_CODES } from "./server-types.js";
import { ProtocolRequestError } from "./server-types.js";
import { createProtocolLogger } from "./server-types.js";
import type { ParamsSchema } from "./server-types.js";
import type { ZCodeProtocolAgentDependencies } from "./server-types.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import type { ZCodeProtocolClientRequestOptions } from "./server-types.js";
import type { ZCodeProtocolSessionRecord } from "./server-types.js";
import { createInMemorySessionEventStore } from "@zcode/contracts";
import { MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS } from "./protocol-server-support.js";
import { getOperationId } from "./protocol-server-support.js";
import { getPluginOperationId } from "./protocol-server-support.js";
import type { PendingClientRequest } from "./protocol-server-support.js";
import type { ZCodeProtocolOutboundMessage } from "./protocol-server-support.js";
import type { ZCodeProtocolPostResponseBatch } from "./protocol-server-support.js";
import { requestMcpElicitation } from "./interaction-broker.js";

export { notifyWorkspaceHookTrustGrantSessions } from "./protocol-server-support.js";

export type { ZCodeProtocolPostResponseBatch } from "./protocol-server-support.js";

export type { ZCodeProtocolAgentDependencies, ZCodeProtocolSessionRecord };

export class ZCodeProtocolAgentServer {
  // 类型声明无实例字段；实现由下方唯一安装器登记在同一 owner 原型。
  declare rebalanceResidentSessions: ZCodeProtocolAgentServerApi["rebalanceResidentSessions"];
  declare pruneSessionEventStores: ZCodeProtocolAgentServerApi["pruneSessionEventStores"];
  declare pruneDetachedChildPublishers: ZCodeProtocolAgentServerApi["pruneDetachedChildPublishers"];
  declare collectMemoryDiagnostics: ZCodeProtocolAgentServerApi["collectMemoryDiagnostics"];
  declare setNotificationSink: ZCodeProtocolAgentServerApi["setNotificationSink"];
  declare disconnectClient: ZCodeProtocolAgentServerApi["disconnectClient"];
  declare shutdown: ZCodeProtocolAgentServerApi["shutdown"];
  declare disposeProjections: ZCodeProtocolAgentServerApi["disposeProjections"];
  declare takePostResponseMessages: ZCodeProtocolAgentServerApi["takePostResponseMessages"];
  declare takePostResponseBatch: ZCodeProtocolAgentServerApi["takePostResponseBatch"];
  declare clearPostResponseMessages: ZCodeProtocolAgentServerApi["clearPostResponseMessages"];
  declare handleMessage: ZCodeProtocolAgentServerApi["handleMessage"];
  declare requestMcpElicitation: ZCodeProtocolAgentServerApi["requestMcpElicitation"];
  declare handleMcpNotification: ZCodeProtocolAgentServerApi["handleMcpNotification"];

  private readonly networkCapture = createNodeNetworkCapture("cli", (batch) => {
    this.messageSink?.({
      method: zcodeProtocolNotifications.processNetworkRequests,
      params: batch,
    });
  });
  private readonly runtimeResources: ProtocolRuntimeResources;
  private shutdownPromise?: Promise<void>;
  readonly browserControlPort: BrowserControlPort;
  /**
   * 官方 MCP 身份头端口所需的最小上下文。
   * MCP 连接池的构造早于 server，需要在 server 就绪后回填闭包持有的引用——
   * 与 v4Gateway 同样的构造顺序收口方式。只暴露 requestClient，不外泄整个 context。
   */
  /** MCP server 发起的 elicitation/create → 用户提问。 */

  /** MCP server 通知 → 会话 live 事件 / agent 日志。 */

  get officialMcpAuthRequestContext(): Pick<ZCodeProtocolAgentServerContext, "requestClient"> {
    return this.context;
  }

  private messageSink?: (message: ZCodeProtocolOutboundMessage) => void;
  private clientDisconnectError?: Error;
  private readonly context: ZCodeProtocolAgentServerContext;
  private readonly logger;
  private readonly pendingClientRequests = new Map<string, PendingClientRequest<unknown>>();
  private readonly pluginOperationControllers = new Map<string, AbortController>();
  private readonly workspaceGenerateTextControllers = new Map<string, AbortController>();
  /**
   * subscribe initial frame 按 JSON-RPC request id 隔离。connection 必须先 take，
   * 再写 response line，最后按数组顺序写 notification，不能靠 microtask 猜时序。
   */
  private readonly postResponseOutbox = new Map<
    ZCodeProtocolRequestId,
    ZCodeProtocolPostResponseBatch
  >();
  private nextClientRequestId = 1;

  constructor(deps: ZCodeProtocolAgentDependencies) {
    this.runtimeResources = new ProtocolRuntimeResources(deps.createZCodeApp);
    const resolvedDeps = {
      ...deps,
      createZCodeApp: this.runtimeResources.create,
      // 默认 turn 窗口保留策略。
      createSessionEventStore:
        deps.createSessionEventStore ?? (() => createInMemorySessionEventStore()),
      workspaceHookPolicyProvider:
        deps.workspaceHookPolicyProvider ?? new InMemoryWorkspaceHookPolicyProvider(),
    };
    this.logger = createProtocolLogger(resolvedDeps);
    this.context = {
      assertServing: () => this.runtimeResources.assertServing(),
      deps: resolvedDeps,
      logger: this.logger,
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
        // 动态工作流灰度门 fail-closed：Host 必须显式 workspace/updateDynamicWorkflowPolicy
        // 才开启。
        dynamicWorkflowEnabled: false,
      },
      notify: (notification) => this.messageSink?.(notification),
      requestClient: (method, params, resultSchema, options) =>
        this.requestClient(method, params, resultSchema, options),
      sessions: new Map<string, ZCodeProtocolSessionRecord>(),
      // 交互应答登记表（broker 反向请求 × v4 resolveInteraction 命令的汇合点）。
      v4Interactions: new V4InteractionRegistry(
        resolveV4InteractionRegistryOptionsFromEnv(deps.env ?? process.env),
      ),
    };
    // v4 通道：gateway 闭包持有 context 做帧出口与命令副作用，构造完立即挂回。
    this.context.v4Gateway = createConversationV4Gateway(this.context);
    this.browserControlPort = createProtocolBrowserControlBroker(this.context);
    const sessionResidentTargetCount =
      deps.sessionResidentPoolOptions?.targetCount ?? deps.sessionResidentTargetCount;
    const sessionResidentHighWaterCount =
      deps.sessionResidentPoolOptions?.highWaterCount ??
      (sessionResidentTargetCount === undefined
        ? undefined
        : Math.max(DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT, sessionResidentTargetCount));
    // 单 CLI resident session 池：协议 request release 主动收敛，资源 sampler 只作兜底。
    this.context.sessionResidentPool = new SessionResidentPool(
      createSessionResidentPoolHost(this.context),
      {
        ...deps.sessionResidentPoolOptions,
        // legacy target 曾同时覆盖 high/low，导致迟滞窗口塌为 0；只覆盖 low。
        // 仅配置 target 且超过默认 high 时抬升隐式 high，显式非法组合仍由 pool 拒绝。
        highWaterCount: sessionResidentHighWaterCount,
        targetCount: sessionResidentTargetCount,
      },
    );
  }

  /** 低频 sampler 兜底入口；正常收敛由每个协议 request 的 operation lease 释放触发。 */

  /**
   * 借同一 60s 节拍做 event store 的时间兜底淘汰：
   * subagent 子 session 只有一个 turn，等不到下一个 turn_started，只能按时间清。返回淘汰条数。
   */

  /** 同一 60s 节拍：释放已终态、无订阅者、无 record 的 detached subagent child publisher。 */

  /**
   * 内存诊断计数器，随 60s 资源采样写本地日志。
   * 只读 Map.size / 数组长度，不触碰 session 状态；持久化 event store 不提供 getStats 时计 0。
   */

  /** 进程资源关闭，不使用会删除产品会话/发布 session.removed 的 session/close。 */

  /** app drain 有界结束后释放投影；即使某个 app.close 挂起也必须执行。 */

  /** 一次性取走某 request 的 post-response messages；重复 take 返回空数组。 */

  /** production NDJSON 取完整 batch；只有全部 write 成功后才调 commit。 */

  /** connection close / server dispose 时释放尚未写出的 initial frame 引用。 */

  declare private handleRequest: OmitThisParameter<typeof implementation2.handleRequest>;

  declare private dispatchRequest: OmitThisParameter<typeof implementation3.dispatchRequest>;

  declare private requireV4Gateway: OmitThisParameter<typeof implementation2.requireV4Gateway>;

  private async withPluginOperationSignal<T>(
    request: ZCodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operationId = getPluginOperationId(request.params);
    if (!operationId) return await run();

    const controller = new AbortController();
    this.pluginOperationControllers.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.pluginOperationControllers.get(operationId) === controller) {
        this.pluginOperationControllers.delete(operationId);
      }
    }
  }

  declare private cancelPluginOperation: OmitThisParameter<
    typeof implementation4.cancelPluginOperation
  >;

  private async withWorkspaceGenerateTextSignal<T>(
    request: ZCodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operationId = getOperationId(request.params);
    if (!operationId) return await run();

    if (this.workspaceGenerateTextControllers.has(operationId)) {
      // 重复 operationId 会覆盖首个请求的 AbortController，导致首个请求失去取消能力。
      // 活跃 operationId 必须保持唯一；请求结束后 finally 会释放，之后才允许复用。
      throw new ProtocolRequestError(
        -32600,
        `Workspace generate operation is already active: ${operationId}`,
      );
    }

    const controller = new AbortController();
    this.workspaceGenerateTextControllers.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.workspaceGenerateTextControllers.get(operationId) === controller) {
        this.workspaceGenerateTextControllers.delete(operationId);
      }
    }
  }

  declare private cancelWorkspaceGenerateText: OmitThisParameter<
    typeof implementation4.cancelWorkspaceGenerateText
  >;

  declare private ok: OmitThisParameter<typeof implementation2.ok>;

  declare private fail: OmitThisParameter<typeof implementation2.fail>;

  private requestClient<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T> {
    if (this.clientDisconnectError) {
      throw this.clientDisconnectError;
    }
    if (!this.messageSink) {
      throw new ProtocolRequestError(
        PROTOCOL_CLIENT_REQUEST_ERROR_CODES.noClientAttached,
        `No ZCode Protocol client is attached for ${method}`,
      );
    }

    return new Promise<T>((resolve, reject) => {
      let active = true;
      const pending: PendingClientRequest<T> = {
        method,
        reject,
        resolve,
        resultSchema,
        requestKeys: new Set(),
        signal: options?.signal,
      };
      const cleanup = () => {
        active = false;
        this.cleanupClientRequest(pending);
      };
      pending.abortHandler = () => {
        cleanup();
        reject(
          new ProtocolRequestError(
            PROTOCOL_CLIENT_REQUEST_ERROR_CODES.cancelled,
            `Client request cancelled: ${method}`,
          ),
        );
      };
      if (options?.signal?.aborted) {
        pending.abortHandler();
        return;
      }
      if (options?.timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          cleanup();
          reject(
            new ProtocolRequestError(
              PROTOCOL_CLIENT_REQUEST_ERROR_CODES.timedOut,
              `Client request timed out: ${method}`,
              {
                timeoutMs: options.timeoutMs,
              },
            ),
          );
        }, options.timeoutMs);
      }
      options?.signal?.addEventListener("abort", pending.abortHandler, { once: true });
      const sendClientRequest = () => {
        if (!active) {
          return;
        }
        const id = `server-${this.nextClientRequestId++}`;
        const key = String(id);
        pending.requestKeys.add(key);
        this.pendingClientRequests.set(key, pending as PendingClientRequest<unknown>);
        this.messageSink?.({
          id,
          method,
          params,
          ...(options?.trace ? { trace: options.trace } : {}),
        });
      };
      sendClientRequest();
      const reannounceIntervalMs =
        options?.reannounceIntervalMs !== undefined &&
        Number.isFinite(options.reannounceIntervalMs) &&
        options.reannounceIntervalMs > 0
          ? Math.floor(options.reannounceIntervalMs)
          : undefined;
      if (reannounceIntervalMs !== undefined) {
        let nextReannounceIntervalMs = reannounceIntervalMs;
        const scheduleReannounce = () => {
          pending.reannounceTimer = setTimeout(() => {
            if (!active) {
              return;
            }
            sendClientRequest();
            nextReannounceIntervalMs = Math.min(
              nextReannounceIntervalMs * 2,
              MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS,
            );
            scheduleReannounce();
          }, nextReannounceIntervalMs);
        };
        scheduleReannounce();
      }
    });
  }

  declare private resolveClientRequest: OmitThisParameter<
    typeof implementation5.resolveClientRequest
  >;

  declare private rejectClientRequest: OmitThisParameter<
    typeof implementation5.rejectClientRequest
  >;

  private cleanupClientRequest<T>(pending: PendingClientRequest<T>): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (pending.reannounceTimer) {
      clearTimeout(pending.reannounceTimer);
    }
    if (pending.abortHandler) {
      pending.signal?.removeEventListener("abort", pending.abortHandler);
    }
    for (const requestKey of pending.requestKeys) {
      this.pendingClientRequests.delete(requestKey);
    }
    pending.requestKeys.clear();
  }
}

installZCodeProtocolAgentServerMethods(ZCodeProtocolAgentServer.prototype);
