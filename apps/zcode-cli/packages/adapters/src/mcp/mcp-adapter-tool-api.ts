import type {
  McpCallToolOptions,
  McpCallToolRequest,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpToolCallResult,
  McpToolDescriptor,
} from "@zcode/contracts";

import { ZCODE_OFFICIAL_MCP_AUTH_TYPE } from "@zcode/shared";

import { normalizeMcpToolDescriptor } from "./descriptor.js";

import { classifyInteractiveAuthorizationTrigger } from "./oauth-errors.js";

import { type OfficialMcpServerResponseInfo } from "./official-auth.js";

import {
  createMcpDeadline,
  remainingMcpDeadlineMs,
  waitWithinMcpDeadline,
  type McpDeadline,
} from "./timeout.js";

import { DEFAULT_MCP_TIMEOUT_MS, MAX_TRACKED_SERVER_REQUEST_IDS } from "./mcp-adapter-contract.js";

import type { McpClient, McpServerRecord } from "./mcp-adapter-contract.js";

import type { NodeMcpAdapterContext } from "./mcp-adapter-context.js";
import { isRecord } from "./mcp-adapter-protocol.js";
export async function listTools(this: NodeMcpAdapterContext): Promise<McpToolDescriptor[]> {
  // 收到 notifications/tools/list_changed 的 server 在下一次 listTools 时重新拉取
  // （runtime 只在回合开始前调用，回合内工具表不变）。
  for (const [name, record] of this.records) {
    if (!record.toolsStale || !record.client || record.status.status !== "connected") continue;
    try {
      const listed = await record.client.listTools();
      record.tools = listed.tools.map((tool) =>
        normalizeMcpToolDescriptor(
          name,
          tool,
          record.config.timeoutMs,
          record.config.type === "http" &&
            record.config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
        ),
      );
      record.status = { ...record.status, toolCount: record.tools.length };
      record.toolsStale = false;
      this.logger?.info("MCP tool list refreshed after list_changed", {
        event: "mcp.tools.refreshed",
        mcpServerName: name,
        toolCount: record.tools.length,
      });
    } catch (error) {
      this.logger?.warn("MCP tool list refresh failed", {
        event: "mcp.tools.refresh_failed",
        mcpServerName: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return Array.from(this.records.values()).flatMap((record) => record.tools);
}

export async function callTool(
  this: NodeMcpAdapterContext,
  request: McpCallToolRequest,
  options: McpCallToolOptions = {},
): Promise<McpToolCallResult> {
  const timeoutMs =
    options.timeoutMs ??
    this.records.get(request.serverName)?.config.timeoutMs ??
    DEFAULT_MCP_TIMEOUT_MS;
  const deadline = createMcpDeadline(timeoutMs);
  const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
  let record: McpServerRecord & { client: McpClient };
  if (options.appConnection) {
    const snapshot = this.appConnectionSnapshot(request.serverName);
    const current = this.records.get(request.serverName);
    if (
      !snapshot ||
      snapshot.identity !== options.appConnection.identity ||
      snapshot.generation !== options.appConnection.generation ||
      !current?.client
    )
      throw new Error("MCP App connection changed");
    options.signal?.throwIfAborted();
    record = current as McpServerRecord & { client: McpClient };
  } else {
    record = await this.resolveConnectedRecord(
      request.serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
  }

  try {
    return await this.callToolOnClient(
      record.client,
      request,
      remainingMcpDeadlineMs(deadline, timeoutMessage),
      options.signal,
      options.onProgress,
    );
  } catch (error) {
    if (options.appConnection) throw error;
    // 连接建立后 token 过期、被撤销或 scope 不足时，
    // 过去这些认证错误原样冒泡，用户看到裸错误且永远不会自愈——OAuth 自愈只存在于
    // startup connect 路径。现在运行期与建连期共用同一套 Phase 2 → Phase 1 编排。
    const trigger = classifyInteractiveAuthorizationTrigger(error);
    if (trigger && record.config.type !== "stdio") {
      return await this.recoverToolCallAuthorization({
        error,
        record,
        request,
        deadline,
        timeoutMessage,
        trigger,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
    }
    // 防 onclose 尚未派发的竞态：SDK 在 transport 已断时抛裸 "Not connected"。
    // 只对这一种确定的断连错误重连重试一次，其余错误原样冒泡。
    if (!(error instanceof Error) || error.message !== "Not connected") throw error;
    try {
      await waitWithinMcpDeadline(
        this.reconnectForCall(request.serverName, record.config),
        deadline,
        timeoutMessage,
        options.signal,
      );
    } catch (reconnectError) {
      this.logger?.warn("MCP server reconnect failed", {
        error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
        event: "mcp.server.reconnect.failed",
        mcpServerName: request.serverName,
        status: "failed",
      });
      throw error;
    }
    const revived = this.records.get(request.serverName);
    if (!revived?.client || revived.status.status !== "connected") throw error;
    return await this.callToolOnClient(
      revived.client,
      request,
      remainingMcpDeadlineMs(deadline, timeoutMessage),
      options.signal,
      options.onProgress,
    );
  }
}

/**
 * 插件 UI 的 `ui://` 资源读取。与 callTool 共用连接等待 / 断连重连骨架（resolveConnectedRecord），
 * 保证走同一条连接与 OAuth 恢复路径；不做 tool 级 OAuth 二次恢复——资源读取失败直接冒泡，
 * 由 UI 回退到普通卡片。
 */

export async function readResource(
  this: NodeMcpAdapterContext,
  request: McpReadResourceRequest,
  options: McpCallToolOptions = {},
): Promise<McpReadResourceResult> {
  const timeoutMs =
    options.timeoutMs ??
    this.records.get(request.serverName)?.config.timeoutMs ??
    DEFAULT_MCP_TIMEOUT_MS;
  const deadline = createMcpDeadline(timeoutMs);
  const timeoutMessage = `MCP resource ${request.serverName} ${request.uri} timed out after ${timeoutMs}ms`;
  const record = await this.resolveConnectedRecord(
    request.serverName,
    deadline,
    timeoutMessage,
    options.signal,
  );
  const result = await record.client.readResource(
    { uri: request.uri },
    { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
  );
  return {
    contents: (result.contents ?? []).map((content) => {
      const item = content as Record<string, unknown>;
      return {
        uri: typeof item.uri === "string" ? item.uri : request.uri,
        ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
        ...(typeof item.text === "string" ? { text: item.text } : {}),
        ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
        ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
      };
    }),
  };
}

/**
 * callTool / readResource 共用：等待共享 connecting 任务、对已断连 record 重连一次、
 * 返回处于 connected 的 record。抽出来是为了让资源读取与工具调用走完全相同的恢复路径。
 */

export async function resolveConnectedRecord(
  this: NodeMcpAdapterContext,
  serverName: string,
  deadline: McpDeadline,
  timeoutMessage: string,
  signal: AbortSignal | undefined,
): Promise<McpServerRecord & { client: McpClient }> {
  const pending = this.records.get(serverName)?.connecting;
  if (pending) {
    // 修复原因：connecting 是 adapter 持有的共享连接/OAuth 恢复任务。过去这里裸 await，
    // tool caller 的 timeout/abort 完全失效；但直接 abort 底层任务又会关闭其他 caller 共用的
    // callback listener。这里只限制当前 waiter，共享任务继续由 record 生命周期持有。
    await waitWithinMcpDeadline(pending, deadline, timeoutMessage, signal);
  }

  // Bugfix：stdio MCP 子进程死亡后（如 node_repl 被异步错误击穿），此前没有任何恢复路径：
  // 连接只在 session 创建时建立一次，session resume 也不重建，该会话的工具从此永远失败。
  // 这里在调用前对已断连的 record 重连一次；server 进程内状态（如 REPL 变量）不可恢复，
  // 但工具本身恢复可用。
  const disconnected = this.records.get(serverName);
  if (disconnected && disconnected.status.status === "disconnected") {
    await waitWithinMcpDeadline(
      this.reconnectForCall(serverName, disconnected.config),
      deadline,
      timeoutMessage,
      signal,
    );
  }

  const record = this.records.get(serverName);
  if (!record?.client || record.status.status !== "connected") {
    throw new Error(`MCP server is not connected: ${serverName}`);
  }
  return record as McpServerRecord & { client: McpClient };
}

/** 连接期诊断按 server 保存；tool call request id 继续按 span 隔离。 */

export function rememberServerResponse(
  this: NodeMcpAdapterContext,
  serverName: string,
  response: OfficialMcpServerResponseInfo,
): void {
  if (
    !response.spanId &&
    response.rpcMethod !== "tools/call" &&
    this.records.get(serverName)?.status.status === "connecting"
  ) {
    if (response.failureKind) {
      this.connectionDiagnosticByServer.set(serverName, {
        failureKind: response.failureKind,
        ...(response.serverRequestId ? { serverRequestId: response.serverRequestId } : {}),
      });
    }
    return;
  }
  if (!response.spanId) return;
  if (!response.serverRequestId) return;
  // 401 重试会对同一 span 产生两条响应，后写覆盖——留下的是最终那次，正是要报的那个。
  this.serverRequestIdBySpan.set(response.spanId, response.serverRequestId);
  while (this.serverRequestIdBySpan.size > MAX_TRACKED_SERVER_REQUEST_IDS) {
    const oldest = this.serverRequestIdBySpan.keys().next();
    if (oldest.done) break;
    this.serverRequestIdBySpan.delete(oldest.value);
  }
}

/** 取出并清除该 span 的 request id。取不到返回 undefined，不做任何兜底猜测。 */

export function takeServerRequestId(
  this: NodeMcpAdapterContext,
  spanId: string | undefined,
): string | undefined {
  if (!spanId) return undefined;
  const requestId = this.serverRequestIdBySpan.get(spanId);
  if (requestId !== undefined) this.serverRequestIdBySpan.delete(spanId);
  return requestId;
}
