import {
  ClientCredentialsProvider,
  computeScopeUnion,
  type AuthProvider,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";

import type { McpServerConfig } from "@zcode/contracts";

import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";

import { createMcpTransportFetch } from "./network.js";

import { loadCredentialPair } from "./oauth-credentials.js";

import { type InteractiveAuthorizationTrigger } from "./oauth-errors.js";

import {
  MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
  runMcpInteractiveAuthorization,
  type McpInteractiveAuthorizationOutcome,
} from "./oauth-interactive.js";

import { createMcpOAuthTokenProvider } from "./oauth-provider.js";

import { createCredentialKeyPrefix, type McpOAuthRuntimeOptions } from "./oauth.js";

import type { AuthorizationCodeOAuthConfig, McpClient } from "./mcp-adapter-contract.js";

import type { NodeMcpAdapterContext } from "./mcp-adapter-context.js";
import {
  createOAuthAuthorizationStatus,
  isOfficialAuthConfig,
  isSupportedElicitationMode,
  resolveAuthorizationCodeOAuthConfig,
} from "./mcp-adapter-protocol.js";
/** server 主动 elicitation/create：归属到该 server 当前工具调用的会话，交给宿主提问端口。 */

export function installElicitationHandler(
  this: NodeMcpAdapterContext,
  client: McpClient,
  serverName: string,
): void {
  const port = this.elicitation;
  const setRequestHandler = (client as unknown as { setRequestHandler?: unknown })
    .setRequestHandler;
  if (!port || typeof setRequestHandler !== "function") return;
  (
    client as unknown as {
      setRequestHandler(
        method: "elicitation/create",
        handler: (request: {
          params: { message: string; requestedSchema?: unknown };
        }) => Promise<unknown>,
      ): void;
    }
  ).setRequestHandler("elicitation/create", async (request) => {
    // 接受缺省 / "form" / 兼容接口的 "openai/form" / "openaiForm"；url 等其它模式 decline。
    const mode = (request.params as { mode?: unknown }).mode;
    if (!isSupportedElicitationMode(mode)) {
      this.logger?.warn("MCP elicitation mode not supported, declining", {
        event: "mcp.elicitation.unsupported_mode",
        mcpServerName: serverName,
        mode: String(mode),
      });
      return { action: "decline" };
    }
    const trace = this.activeCallTraces.get(serverName);
    const result = await port.requestElicitation({
      serverName,
      message: request.params.message,
      requestedSchema: request.params.requestedSchema,
      ...(trace ? { trace } : {}),
    });
    return result.action === "accept"
      ? { action: "accept", content: result.content ?? {} }
      : { action: result.action };
  });
}

/**
 * Phase 2：交互授权。
 *
 * 授权事务的寿命是 300 秒，与 caller 的等待预算（session 15 秒）无关；caller 侧的收口发生在
 * `connectServer` / `waitForSharedConnection`，本方法不感知 caller 预算。
 */

export async function runInteractiveOAuthAuthorization(
  this: NodeMcpAdapterContext,
  input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  },
): Promise<McpInteractiveAuthorizationOutcome> {
  try {
    const oauthOptions = this.createAuthorizationCodeOAuthOptions(
      input.config,
      input.name,
      input.generation,
    );
    const credentialStore = oauthOptions?.credentialStore ?? createSharedZCodeCredentialStore();
    const keyPrefix = createCredentialKeyPrefix(input.name, input.serverUrl, input.oauthConfig);
    // 403 step-up 的最终 scope 必须是 config ∪ token.scope ∪ challenge
    // 的并集。只带 challenge scope 重新授权时，授权服务器可能按新请求收回先前授予的 scope，
    // 下一个请求换个 challenge 又 403，形成重授权乒乓。token response 的 scope 允许缺失
    // （RFC 6749 §3.3），所以配置里声明过的 scope 必须显式并入，不能只看 token 回显。
    let requestedScope: string | undefined = input.oauthConfig.scope;
    if (input.trigger.requiredScope) {
      const currentPair = await loadCredentialPair(credentialStore, keyPrefix);
      requestedScope = computeScopeUnion(
        input.oauthConfig.scope,
        currentPair?.tokens?.scope,
        input.trigger.requiredScope,
      );
    }
    return await runMcpInteractiveAuthorization({
      adapterInstanceId: this.adapterInstanceId,
      config: input.oauthConfig,
      credentialStore,
      fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
      // 403 step-up：requiredScope 是当前 token scope 的严格超集时 refresh 无法扩权
      // （RFC 6749 §6），必须强制重新授权，否则新 scope 会被静默丢弃并再次 403。
      ...(input.trigger.reason === "insufficient_scope" ? { forceReauthorization: true } : {}),
      keyPrefix,
      logger: this.logger,
      ...(oauthOptions?.onAuthorizationRequired
        ? { onAuthorizationRequired: oauthOptions.onAuthorizationRequired }
        : {}),
      ...(oauthOptions?.openAuthorizationUrl
        ? { openAuthorizationUrl: oauthOptions.openAuthorizationUrl }
        : {}),
      ...(requestedScope ? { requestedScope } : {}),
      ...(input.trigger.resourceMetadataUrl
        ? { resourceMetadataUrl: new URL(input.trigger.resourceMetadataUrl) }
        : {}),
      serverName: input.name,
      serverUrl: input.serverUrl,
      signal: input.signal,
      transactionTtlMs: MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
    });
  } catch (error) {
    // 本方法的返回类型已经把编排失败建模为 outcome。过去 credential load、
    // authz lease 或 follower callback 的异常会裸 reject，绕过 failConnection，留下
    // status=connecting + rejected record.connecting，并让 connectConfiguredServers 整批失败。
    this.logger?.warn("MCP OAuth authorization orchestration failed", {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : "unknown",
      event: "mcp.oauth.authorization.orchestration_failed",
      mcpServerName: input.name,
      status: "failed",
    });
    return { status: "failed", error };
  }
}

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

export function createOAuthClientProvider(
  this: NodeMcpAdapterContext,
  serverName: string,
  config: McpServerConfig,
): AuthProvider | OAuthClientProvider | undefined {
  if (config.type === "stdio") return undefined;
  // 官方鉴权与 OAuth 互斥：官方 MCP 的失败只能由 ZCode 登录/套餐解决，
  // 交出任何 authProvider 都会让 401 误转成 MCP 授权流程。
  if (isOfficialAuthConfig(config)) return undefined;
  const authorizationCodeOAuthConfig = resolveAuthorizationCodeOAuthConfig(config);
  if (authorizationCodeOAuthConfig) {
    return createMcpOAuthTokenProvider({
      config: authorizationCodeOAuthConfig,
      credentialStore: this.resolveCredentialStore(),
      fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
      keyPrefix: createCredentialKeyPrefix(serverName, config.url, authorizationCodeOAuthConfig),
      ...(this.logger ? { logger: this.logger } : {}),
      serverName,
      serverUrl: config.url,
    });
  }
  if (config.oauth?.type === "client_credentials") {
    return new ClientCredentialsProvider({
      clientId: config.oauth.clientId,
      clientName: config.oauth.clientName ?? `${this.clientName}-${serverName}`,
      clientSecret: config.oauth.clientSecret,
      scope: config.oauth.scope,
    });
  }
  return undefined;
}

export function resolveCredentialStore(this: NodeMcpAdapterContext): SharedZCodeCredentialStore {
  this.credentialStore ??= this.mcpOAuth?.credentialStore ?? createSharedZCodeCredentialStore();
  return this.credentialStore;
}

export function createAuthorizationCodeOAuthOptions(
  this: NodeMcpAdapterContext,
  config: McpServerConfig,
  serverName: string,
  generation: number,
  oauthAuthorizationTimeoutMs?: number,
): McpOAuthRuntimeOptions | undefined {
  if (config.type === "stdio") return this.mcpOAuth;
  return {
    ...this.mcpOAuth,
    authorizationTimeoutMs: oauthAuthorizationTimeoutMs ?? this.mcpOAuth?.authorizationTimeoutMs,
    onAuthorizationRequired: async (context) => {
      this.updateCurrentRecordStatus(serverName, generation, {
        authorization: createOAuthAuthorizationStatus(context),
        status: "connecting",
      });
      await this.mcpOAuth?.onAuthorizationRequired?.(context);
    },
  };
}
