import type { NodeMcpAdapterApi } from "./mcp-adapter-api.js";
import * as implementation0 from "./mcp-adapter-connection-api.js";
import * as implementation2 from "./mcp-adapter-connection-cleanup.js";
import * as implementation3 from "./mcp-adapter-connection-state.js";
import * as implementation8 from "./mcp-adapter-interactive-auth.js";
import * as implementation1 from "./mcp-adapter-open.js";
import * as implementation6 from "./mcp-adapter-resources.js";
import * as implementation7 from "./mcp-adapter-stdio-auth.js";
import * as implementation4 from "./mcp-adapter-tool-api.js";
import * as implementation5 from "./mcp-adapter-tool-execution.js";

import type {
  Logger,
  McpElicitationPort,
  McpElicitationTrace,
  McpNotificationPort,
  McpPort,
  McpServerStatus,
} from "@zcode/contracts";

import { type OfficialMcpAuthFailureKind } from "@zcode/shared";

import { randomUUID } from "node:crypto";

import { type SharedZCodeCredentialStore } from "../auth/shared-credentials.js";

import { type NetworkEgressEnvPolicy } from "./network.js";

import { type McpOAuthRuntimeOptions } from "./oauth.js";

import {
  createMcpConnectionPool,
  type McpConnectionContext,
  type McpConnectionPool,
} from "./pool.js";

import { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";

import type { McpTelemetryTracker } from "./telemetry.js";

import type { CreateMcpAdapterOptions, McpServerRecord } from "./mcp-adapter-contract.js";

export {
  MCP_NOTIFICATION_MESSAGE,
  MCP_NOTIFICATION_RESOURCES_LIST_CHANGED,
  MCP_NOTIFICATION_RESOURCES_UPDATED,
  MCP_NOTIFICATION_TOOLS_LIST_CHANGED,
} from "./mcp-adapter-contract.js";

export type { CreateMcpAdapterOptions } from "./mcp-adapter-contract.js";

export {
  createMcpConnectionPool,
  type McpConnectionPool,
  type McpConnectionPoolOptions,
} from "./pool.js";

export {
  createMcpTelemetryTracker,
  resolvePluginName,
  type McpTelemetryTracker,
  type McpTrackedProcess,
} from "./telemetry.js";

export function createMcpAdapter(options: CreateMcpAdapterOptions = {}): McpPort {
  return new NodeMcpAdapter(options);
}

export function createMcpAdapterConnectionPool(
  options: CreateMcpAdapterOptions = {},
): McpConnectionPool {
  return createMcpConnectionPool({
    logger: options.logger,
    telemetry: options.telemetry,
    createAdapter: ({ connectionContext, workingDirectory }) =>
      createMcpAdapter({
        ...options,
        connectionContext,
        workingDirectory: workingDirectory ?? options.workingDirectory,
      }),
  });
}

class NodeMcpAdapter implements McpPort {
  // 类型声明无实例字段；实现由下方唯一安装器登记在同一 owner 原型。
  declare connectConfiguredServers: NodeMcpAdapterApi["connectConfiguredServers"];
  declare connectServer: NodeMcpAdapterApi["connectServer"];
  declare disconnectServer: NodeMcpAdapterApi["disconnectServer"];
  declare status: NodeMcpAdapterApi["status"];
  declare pingServer: NodeMcpAdapterApi["pingServer"];
  declare toolListRevision: NodeMcpAdapterApi["toolListRevision"];
  declare close: NodeMcpAdapterApi["close"];
  declare onAppConnectionInvalidated: NodeMcpAdapterApi["onAppConnectionInvalidated"];
  declare appConnectionSnapshot: NodeMcpAdapterApi["appConnectionSnapshot"];
  declare listTools: NodeMcpAdapterApi["listTools"];
  declare callTool: NodeMcpAdapterApi["callTool"];
  declare readResource: NodeMcpAdapterApi["readResource"];
  declare listResources: NodeMcpAdapterApi["listResources"];
  declare listResourceTemplates: NodeMcpAdapterApi["listResourceTemplates"];
  declare subscribeResource: NodeMcpAdapterApi["subscribeResource"];
  declare unsubscribeResource: NodeMcpAdapterApi["unsubscribeResource"];
  declare unsubscribeResourcesBySubscriber: NodeMcpAdapterApi["unsubscribeResourcesBySubscriber"];
  declare resourceSubscriptionCounts: NodeMcpAdapterApi["resourceSubscriptionCounts"];

  private readonly adapterInstanceId = randomUUID();
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly connectionContext?: McpConnectionContext;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly logger?: Logger;
  private readonly mcpOAuth?: McpOAuthRuntimeOptions;
  private readonly network?: NetworkEgressEnvPolicy;
  private readonly officialMcpAuth?: CreateMcpAdapterOptions["officialMcpAuth"];
  private readonly telemetry?: McpTelemetryTracker;
  private readonly connectionGenerations = new Map<string, number>();
  private credentialStore?: SharedZCodeCredentialStore;
  /**
   * 官方鉴权失败分类的暂存槽。不能从 error 对象读——SDK 的 version
   * negotiation 会把 OfficialMcpAuthError 重新包装成普通 Error，instanceof 失效；
   * 也不允许按错误文本反解。因此在抛出点写入，failConnection 取用后立即清除。
   */
  private readonly lastOfficialAuthKind = new Map<string, OfficialMcpAuthFailureKind>();
  /**
   * span → 服务端 request id。只有官方 MCP 会写入（唯一能看到响应头的地方是 auth fetch
   * wrapper），供 in-band 失败（HTTP 200 + `isError`）把 id 带回 tool result。
   *
   * 用 span 而不是 traceId 作键：traceId 覆盖整个顶层 session，同一 session 的多次调用
   * 共用它，关联会串号；span 是一次 tool call 的粒度。
   *
   * 有界并即取即删：拿不到匹配的 span（如 initialize / tools/list，它们没有 `_meta`）
   * 就让条目自然被挤出，绝不"取最近一次"兜底——那会把上一次调用的 id 贴到这一次的失败上。
   */
  private readonly serverRequestIdBySpan = new Map<string, string>();
  private readonly connectionDiagnosticByServer = new Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >();
  private readonly records = new Map<string, McpServerRecord>();
  private readonly workingDirectory?: string;
  private readonly elicitation?: McpElicitationPort;
  private readonly notifications?: McpNotificationPort;
  /** 资源订阅登记表 serverName → uri → subscriberKey；唯一 owner，连接层计数。 */
  private readonly resourceSubscriptions = new McpResourceSubscriptionRegistry();
  /** tools/list_changed 累计次数，runtime 按此判断是否需要重注册。 */
  private toolListRevisionCounter = 0;
  /** 每个 server 当前正在执行的工具调用 trace；elicitation 借此归属到会话 / 工具行。 */
  private readonly activeCallTraces = new Map<string, McpElicitationTrace>();

  constructor(options: CreateMcpAdapterOptions) {
    this.clientName = options.clientName ?? "zcode";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.connectionContext = options.connectionContext;
    this.env = options.env;
    this.logger = options.logger?.child({
      ...this.connectionContext,
      module: "adapters.mcp",
    });
    this.mcpOAuth = options.mcpOAuth;
    this.network = options.network;
    this.officialMcpAuth = options.officialMcpAuth;
    this.telemetry = options.telemetry;
    this.workingDirectory = options.workingDirectory;
    this.elicitation = options.elicitation;
    this.notifications = options.notifications;
  }

  // HTTP/SSE MCP 服务被停掉时不会派发 onclose（没有常驻流可断），record 会长期停在
  // connected；设置页刷新读到的就是这份"无声死亡"的旧快照，看起来像刷新按钮没生效。
  // ping 是 MCP 基础协议方法，用它把 transport 存活性显式化。

  /** `resources/list`，分页游标透传。 */

  /**
   * 按 (serverName, uri) 计数的订阅。同一连接被多个 session 共享时只向 server 订阅一次；
   * server 没声明 resources.subscribe 能力 → McpResourceSubscribeUnsupportedError。
   */

  /** 登记表快照（测试 / 诊断）：serverName → uri → 订阅者数。 */

  declare private unsubscribeOnServer: OmitThisParameter<
    typeof implementation6.unsubscribeOnServer
  >;

  /** 断连重连后按登记表重放 subscribe（A3）；单条失败不影响其它。 */
  declare private replayResourceSubscriptions: OmitThisParameter<
    typeof implementation6.replayResourceSubscriptions
  >;

  declare private resolveForResourceRequest: OmitThisParameter<
    typeof implementation6.resolveForResourceRequest
  >;

  /**
   * server 主动通知。订阅类通知附上当前登记的 subscriberKey（宿主据此按会话拆分）；
   * tools/list_changed 只标记 stale，下一次 listTools 再拉；没有端口时 SDK 默认丢弃。
   */
  declare private installNotificationHandlers: OmitThisParameter<
    typeof implementation6.installNotificationHandlers
  >;

  /**
   * 插件 UI 的 `ui://` 资源读取。与 callTool 共用连接等待 / 断连重连骨架（resolveConnectedRecord），
   * 保证走同一条连接与 OAuth 恢复路径；不做 tool 级 OAuth 二次恢复——资源读取失败直接冒泡，
   * 由 UI 回退到普通卡片。
   */

  /**
   * callTool / readResource 共用：等待共享 connecting 任务、对已断连 record 重连一次、
   * 返回处于 connected 的 record。抽出来是为了让资源读取与工具调用走完全相同的恢复路径。
   */
  declare private resolveConnectedRecord: OmitThisParameter<
    typeof implementation4.resolveConnectedRecord
  >;

  /** 连接期诊断按 server 保存；tool call request id 继续按 span 隔离。 */
  declare private rememberServerResponse: OmitThisParameter<
    typeof implementation4.rememberServerResponse
  >;

  /** 取出并清除该 span 的 request id。取不到返回 undefined，不做任何兜底猜测。 */
  declare private takeServerRequestId: OmitThisParameter<
    typeof implementation4.takeServerRequestId
  >;

  /**
   * 解析 stdio 官方 MCP 本次出站协议消息的身份头。
   * 返回 undefined 表示"不是官方 stdio server"——此时 `_meta` 里绝不能出现该键，否则等于把
   * 身份头广播给任意第三方插件。
   */
  declare private resolveOfficialStdioAuthMeta: OmitThisParameter<
    typeof implementation7.resolveOfficialStdioAuthMeta
  >;

  /** server 主动 elicitation/create：归属到该 server 当前工具调用的会话，交给宿主提问端口。 */
  declare private installElicitationHandler: OmitThisParameter<
    typeof implementation8.installElicitationHandler
  >;

  /** 调用期间登记 trace，server 在这段时间发起的 elicitation 才能归属到会话 / 工具行。 */
  declare private callToolOnClient: OmitThisParameter<typeof implementation5.callToolOnClient>;

  declare private callToolOnClientInner: OmitThisParameter<
    typeof implementation5.callToolOnClientInner
  >;

  declare private reconnectForCall: OmitThisParameter<typeof implementation5.reconnectForCall>;

  /**
   * 运行期认证恢复：Phase 2 交互授权 → Phase 1 重连 → 原 tool call 最多安全重试一次。
   *
   * 与建连期共用 `runInteractiveOAuthAuthorization`，因此单飞、fencing、caller 预算语义完全一致。
   */
  declare private recoverToolCallAuthorization: OmitThisParameter<
    typeof implementation5.recoverToolCallAuthorization
  >;

  /**
   * 创建或复用运行期 OAuth 恢复。完整的 Phase 2 → Phase 1 由 adapter-owned record 持有；
   * tool caller 只能等待，不能用自己的 AbortSignal 终止共享事务。
   */
  declare private ensureToolCallAuthorizationRecovery: OmitThisParameter<
    typeof implementation5.ensureToolCallAuthorizationRecovery
  >;

  declare private runToolCallAuthorizationRecovery: OmitThisParameter<
    typeof implementation5.runToolCallAuthorizationRecovery
  >;

  declare private waitForSharedConnection: OmitThisParameter<
    typeof implementation1.waitForSharedConnection
  >;

  declare private openServerConnection: OmitThisParameter<
    typeof implementation1.openServerConnection
  >;

  /**
   * Phase 2：交互授权。
   *
   * 授权事务的寿命是 300 秒，与 caller 的等待预算（session 15 秒）无关；caller 侧的收口发生在
   * `connectServer` / `waitForSharedConnection`，本方法不感知 caller 预算。
   */
  declare private runInteractiveOAuthAuthorization: OmitThisParameter<
    typeof implementation8.runInteractiveOAuthAuthorization
  >;

  declare private failConnection: OmitThisParameter<typeof implementation2.failConnection>;

  declare private createTransport: OmitThisParameter<typeof implementation2.createTransport>;

  /**
   * 官方鉴权 MCP 的动态 fetch。返回 undefined 表示走普通 MCP 路径。
   *
   * trusted origin 依赖缺失时直接 fail closed。auth port 可以缺失：wrapper 仍校验 origin，
   * 各请求匿名降级并由服务端做权威判定。
   */
  declare private createOfficialAuthFetch: OmitThisParameter<
    typeof implementation7.createOfficialAuthFetch
  >;

  /**
   * 运行期 auth provider。
   *
   * 过去这里对任何没有 Authorization header 的 HTTP/SSE MCP
   * 都创建一个完整 OAuth session——而 session 在返回前就 `listen(0)` 起了一个 callback server，
   * 即使凭据完全有效、根本不需要授权。同时完整 `OAuthClientProvider` 会让 401 走 SDK 的
   * `auth()`，绕过我们的 refresh 单飞锁。
   *
   * 现在 authorization_code 一律使用纯 AuthProvider：被动连接零 listener、零 discovery、零 DCR，
   * 交互授权只在 Phase 2 事务里发生。
   */
  declare private createOAuthClientProvider: OmitThisParameter<
    typeof implementation8.createOAuthClientProvider
  >;

  declare private resolveCredentialStore: OmitThisParameter<
    typeof implementation8.resolveCredentialStore
  >;

  declare private createAuthorizationCodeOAuthOptions: OmitThisParameter<
    typeof implementation8.createAuthorizationCodeOAuthOptions
  >;

  declare private attachStdioLogging: OmitThisParameter<typeof implementation2.attachStdioLogging>;

  declare private closeRecord: OmitThisParameter<typeof implementation2.closeRecord>;

  declare private closeClientAndTransport: OmitThisParameter<
    typeof implementation2.closeClientAndTransport
  >;

  declare private terminateStdioProcessTree: OmitThisParameter<
    typeof implementation2.terminateStdioProcessTree
  >;

  private readonly appConnectionListeners = new Map<string, Set<() => void>>();

  declare private nextConnectionGeneration: OmitThisParameter<
    typeof implementation3.nextConnectionGeneration
  >;

  declare private isCurrentConnection: OmitThisParameter<
    typeof implementation3.isCurrentConnection
  >;

  declare private updateCurrentRecord: OmitThisParameter<
    typeof implementation3.updateCurrentRecord
  >;

  declare private updateCurrentRecordStatus: OmitThisParameter<
    typeof implementation3.updateCurrentRecordStatus
  >;

  declare private createStatus: OmitThisParameter<typeof implementation3.createStatus>;
}

export type InternalNodeMcpAdapter = NodeMcpAdapter;

// 与 owner 共享原型和 this；保持方法不可枚举，clone/继承沿原路径工作。
for (const methods of [
  implementation0,
  implementation1,
  implementation2,
  implementation3,
  implementation4,
  implementation5,
  implementation6,
  implementation7,
  implementation8,
]) {
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(NodeMcpAdapter.prototype, name, {
      value,
      writable: true,
      configurable: true,
    });
  }
}
