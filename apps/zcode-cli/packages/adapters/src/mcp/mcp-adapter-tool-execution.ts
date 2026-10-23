import type {
  McpCallToolOptions,
  McpCallToolRequest,
  McpContentBlock,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
} from "@zcode/contracts";

import { ZCODE_MCP_SERVER_REQUEST_ID_META_KEY } from "@zcode/contracts";

import { isDeepStrictEqual } from "node:util";

import { type InteractiveAuthorizationTrigger } from "./oauth-errors.js";

import { remainingMcpDeadlineMs, waitWithinMcpDeadline, type McpDeadline } from "./timeout.js";

import { DEFAULT_MCP_TIMEOUT_MS } from "./mcp-adapter-contract.js";

import type {
  AuthorizationCodeOAuthConfig,
  McpClient,
  McpServerRecord,
  McpTransport,
} from "./mcp-adapter-contract.js";

import type { NodeMcpAdapterContext } from "./mcp-adapter-context.js";
import {
  isRecord,
  mcpRequestMeta,
  resolveAuthorizationCodeOAuthConfig,
} from "./mcp-adapter-protocol.js";
/** 调用期间登记 trace，server 在这段时间发起的 elicitation 才能归属到会话 / 工具行。 */

export async function callToolOnClient(
  this: NodeMcpAdapterContext,
  client: McpClient,
  request: McpCallToolRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onProgress?: McpCallToolOptions["onProgress"],
): Promise<McpToolCallResult> {
  this.activeCallTraces.set(request.serverName, {
    ...(request.trace?.sessionId ? { sessionId: String(request.trace.sessionId) } : {}),
    ...(request.trace?.turnId ? { turnId: String(request.trace.turnId) } : {}),
    ...(request.trace?.traceId ? { traceId: String(request.trace.traceId) } : {}),
  });
  try {
    return await this.callToolOnClientInner(client, request, timeoutMs, signal, onProgress);
  } finally {
    this.activeCallTraces.delete(request.serverName);
  }
}

export async function callToolOnClientInner(
  this: NodeMcpAdapterContext,
  client: McpClient,
  request: McpCallToolRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onProgress?: McpCallToolOptions["onProgress"],
): Promise<McpToolCallResult> {
  // 工具调用此前完全无日志：超时时既看不到预算是多少，也无法区分"服务端慢"与
  // "客户端预算太小"。这里记录预算与耗时，但只记参数的 key（值可能是用户输入）。
  const logBase = {
    event: "mcp.tool.call",
    mcpServerName: request.serverName,
    mcpToolName: request.toolName,
    module: "adapters.mcp",
    timeoutMs,
  };
  const argumentKeys = Object.keys(request.arguments ?? {}).sort();
  this.logger?.debug("MCP tool call started", {
    ...logBase,
    argumentKeys,
    status: "started",
  });

  const startedAt = Date.now();
  try {
    const result = await client.callTool(
      {
        name: request.toolName,
        arguments: request.arguments ?? {},
        ...(request.trace || request.runtimeScope || request.workspaceKey || request.workspacePath
          ? { _meta: mcpRequestMeta(request) }
          : {}),
      },
      {
        signal,
        timeout: timeoutMs,
        // 进度通知重置超时（A8）：长任务只要持续上报就不会被 timeoutMs 打断；总时长由工具级 _meta.timeoutMs 约束。
        resetTimeoutOnProgress: true,
        ...(onProgress
          ? {
              onprogress: (notification: { progress: number; total?: number; message?: string }) =>
                onProgress({
                  progress: notification.progress,
                  ...(notification.total !== undefined ? { total: notification.total } : {}),
                  ...(notification.message !== undefined ? { message: notification.message } : {}),
                }),
            }
          : {}),
      },
    );

    const durationMs = Date.now() - startedAt;
    const isError = typeof result.isError === "boolean" ? result.isError : false;
    // 官方 MCP 的 in-band 失败（配额耗尽、无套餐）是 HTTP 200 + isError，wrapper 那条
    // 非 2xx warn 覆盖不到；request id 也只有 wrapper 能看到，所以在这里按 span 取回。
    const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
    const outcome = {
      ...logBase,
      contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
      durationMs,
      hasStructuredContent: result.structuredContent !== undefined,
      // 业务级失败（isError）与传输级失败不同，必须能分开统计。
      isError,
      ...(serverRequestId ? { serverRequestId } : {}),
    };
    if (isError) {
      // 之前 in-band 失败只有这条 debug，而生产 logger 最低级别是 Info——等于配额耗尽
      // 这类失败在生产日志里完全不可见。
      this.logger?.warn("MCP tool returned an error", { ...outcome, status: "failed" });
    } else {
      this.logger?.debug("MCP tool call completed", { ...outcome, status: "completed" });
    }

    const meta = isRecord(result._meta) ? result._meta : undefined;
    return {
      content: Array.isArray(result.content)
        ? (result.content as McpContentBlock[])
        : [{ type: "text", text: "" }],
      structuredContent: result.structuredContent,
      isError: typeof result.isError === "boolean" ? result.isError : undefined,
      // 只在失败时附加：成功路径上它是纯噪声。服务端已给的键一律不覆盖。
      _meta:
        isError && serverRequestId
          ? { ...meta, [ZCODE_MCP_SERVER_REQUEST_ID_META_KEY]: serverRequestId }
          : meta,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    // 判定是否为超时：SDK 超时会抛 MCP error code -32001 (RequestTimeout)，
    // 底层 fetch abort 抛 AbortError。两者都要能一眼认出，否则只能看到裸 message。
    const timedOut =
      /timed?\s*out|timeout/i.test(message) ||
      (error instanceof Error && error.name === "AbortError");
    // 传输级失败也带上：4xx/5xx 时 SDK 抛出的 message 里没有 request id。
    const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
    this.logger?.warn("MCP tool call failed", {
      ...logBase,
      argumentKeys,
      durationMs,
      error: message,
      ...(serverRequestId ? { serverRequestId } : {}),
      errorName: error instanceof Error ? error.name : "unknown",
      status: "failed",
      timedOut,
      // 耗时贴着预算 ⇒ 是我们掐断的；远小于预算 ⇒ 是对端或网络断的。
      ...(timedOut ? { budgetExhausted: durationMs >= timeoutMs * 0.9 } : {}),
    });
    throw error;
  }
}

export async function reconnectForCall(
  this: NodeMcpAdapterContext,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  this.logger?.warn("MCP server reconnecting after lost connection", {
    event: "mcp.server.reconnect.started",
    mcpServerName: name,
    status: "started",
    transport: config.type,
  });
  await this.connectServer(name, config);
}

/**
 * 运行期认证恢复：Phase 2 交互授权 → Phase 1 重连 → 原 tool call 最多安全重试一次。
 *
 * 与建连期共用 `runInteractiveOAuthAuthorization`，因此单飞、fencing、caller 预算语义完全一致。
 */

export async function recoverToolCallAuthorization(
  this: NodeMcpAdapterContext,
  input: {
    deadline: McpDeadline;
    error: unknown;
    record: McpServerRecord;
    request: McpCallToolRequest;
    signal?: AbortSignal;
    onProgress?: McpCallToolOptions["onProgress"];
    timeoutMessage: string;
    trigger: InteractiveAuthorizationTrigger;
  },
): Promise<McpToolCallResult> {
  const { record, request } = input;
  const config = record.config;
  if (config.type === "stdio") throw input.error;
  const oauthConfig = resolveAuthorizationCodeOAuthConfig(config);
  if (!oauthConfig) throw input.error;

  this.logger?.warn("MCP tool call requires OAuth authorization", {
    event: "mcp.oauth.tool_call.authorization_required",
    mcpServerName: request.serverName,
    oauthTriggerReason: input.trigger.reason,
    status: "started",
    toolName: request.toolName,
  });

  const recovery = this.ensureToolCallAuthorizationRecovery({
    config,
    name: request.serverName,
    oauthConfig,
    record,
    trigger: input.trigger,
  });
  const recoveredStatus = await waitWithinMcpDeadline(
    recovery,
    input.deadline,
    input.timeoutMessage,
    input.signal,
  );
  if (recoveredStatus.status !== "connected") {
    throw input.error;
  }

  const revived = this.records.get(request.serverName);
  if (!revived?.client || revived.status.status !== "connected") throw input.error;
  return await this.callToolOnClient(
    revived.client,
    request,
    remainingMcpDeadlineMs(input.deadline, input.timeoutMessage),
    input.signal,
    input.onProgress,
  );
}

/**
 * 创建或复用运行期 OAuth 恢复。完整的 Phase 2 → Phase 1 由 adapter-owned record 持有；
 * tool caller 只能等待，不能用自己的 AbortSignal 终止共享事务。
 */

export function ensureToolCallAuthorizationRecovery(
  this: NodeMcpAdapterContext,
  input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    record: McpServerRecord;
    trigger: InteractiveAuthorizationTrigger;
  },
): Promise<McpServerStatus> {
  const current = this.records.get(input.name);
  if (
    current?.connecting &&
    current.status.status === "connecting" &&
    isDeepStrictEqual(current.config, input.config)
  ) {
    return current.connecting;
  }

  const generation = this.nextConnectionGeneration(input.name);
  const abortController = new AbortController();
  const recoveryRecord: McpServerRecord = {
    abortController,
    config: input.config,
    status: this.createStatus(input.config, "connecting", {
      toolCount: input.record.tools.length,
    }),
    // 运行期工具已经向 core 广告；恢复期间保留 descriptor，避免设置页/借用端口误判工具消失。
    tools: input.record.tools,
  };
  this.records.set(input.name, recoveryRecord);
  const connecting = this.runToolCallAuthorizationRecovery({
    abortController,
    config: input.config,
    generation,
    name: input.name,
    oauthConfig: input.oauthConfig,
    previousClient: input.record.client,
    previousTransport: input.record.transport,
    trigger: input.trigger,
  });
  recoveryRecord.connecting = connecting;
  return connecting;
}

export async function runToolCallAuthorizationRecovery(
  this: NodeMcpAdapterContext,
  input: {
    abortController: AbortController;
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    previousClient?: McpClient;
    previousTransport?: McpTransport;
    trigger: InteractiveAuthorizationTrigger;
  },
): Promise<McpServerStatus> {
  const startedAt = Date.now();
  try {
    // 原 transport 的握手与 token 已失效，必须由共享 owner 统一退休；不能调用 connectServer，
    // 否则 closeRecord 会 abort recoveryRecord 自己的 controller，形成自取消。
    await this.closeClientAndTransport(input.name, input.previousClient, input.previousTransport);
    const outcome = await this.runInteractiveOAuthAuthorization({
      config: input.config,
      generation: input.generation,
      name: input.name,
      oauthConfig: input.oauthConfig,
      serverUrl: input.config.url,
      signal: input.abortController.signal,
      trigger: input.trigger,
    });
    if (outcome.status === "authorized" || outcome.status === "already-authorized") {
      return await this.openServerConnection({
        config: input.config,
        generation: input.generation,
        name: input.name,
        oauthAuthorizationAttempted: true,
        signal: input.abortController.signal,
        timeoutMs: input.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
      });
    }
    return await this.failConnection({
      config: input.config,
      error:
        outcome.status === "pending"
          ? new Error(
              `MCP server ${input.name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
            )
          : outcome.error,
      failureKind: "oauth_authorization_failed",
      generation: input.generation,
      name: input.name,
      startedAt,
    });
  } catch (error) {
    // 防御边界：共享 recovery promise 必须是 total operation。任何未来新增的编排异常也只能
    // 收敛为 failed record，不能留下 rejected connecting promise 污染后续 snapshot。
    return await this.failConnection({
      config: input.config,
      error,
      failureKind: "oauth_authorization_failed",
      generation: input.generation,
      name: input.name,
      startedAt,
    });
  }
}
