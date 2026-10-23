import { SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import type { McpServerConfig, McpServerStatus } from "@zcode/contracts";

import { OFFICIAL_MCP_AUTH_META_KEY, type McpServerFailureKind } from "@zcode/shared";

import { resolve } from "node:path";

import { buildMcpStdioEnv, createMcpTransportFetch } from "./network.js";

import { OfficialMcpAuthError } from "./official-auth.js";

import { terminateMcpStdioProcessTree } from "./process-tree.js";

import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";

import { McpTimeoutError } from "./timeout.js";

import { MCP_STDIO_STDERR_LOG_MAX_CHARS } from "./mcp-adapter-contract.js";

import type { McpClient, McpTransport } from "./mcp-adapter-contract.js";

import type { NodeMcpAdapterContext } from "./mcp-adapter-context.js";
import {
  createBoundedTextBuffer,
  getStdioTransportPid,
  isOfficialAuthConfig,
  sanitizeMcpStdioStderr,
} from "./mcp-adapter-protocol.js";
export async function failConnection(
  this: NodeMcpAdapterContext,
  input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  },
): Promise<McpServerStatus> {
  const {
    client,
    config,
    connectDurationMs,
    error,
    failureKind: fallbackFailureKind,
    generation,
    getRecentStderr,
    listToolsDurationMs,
    name,
    startedAt,
    transport,
  } = input;
  const message = error instanceof Error ? error.message : String(error);
  // 官方 MCP 鉴权失败的稳定分类必须落进日志：failConnection 原先只记
  // error.message，而多数分类并不出现在 message 文本里（只有 auth-port 那条带上了），
  // 导致 official_mcp_origin_untrusted / official_auth_rejected 等在生产日志里 grep 不到。
  const officialAuthKind =
    (error instanceof OfficialMcpAuthError ? error.kind : undefined) ??
    this.lastOfficialAuthKind.get(name);
  this.lastOfficialAuthKind.delete(name);
  const responseDiagnostic = this.connectionDiagnosticByServer.get(name);
  this.connectionDiagnosticByServer.delete(name);
  const failureKind =
    (officialAuthKind === "official_mcp_origin_untrusted"
      ? "official_origin_untrusted"
      : undefined) ??
    responseDiagnostic?.failureKind ??
    (error instanceof McpTimeoutError && fallbackFailureKind !== "tool_list_failed"
      ? "connection_timeout"
      : undefined) ??
    fallbackFailureKind ??
    "connection_failed";
  const displayMessage = responseDiagnostic?.serverRequestId
    ? `${message} - ${responseDiagnostic.serverRequestId}`
    : message;
  const status = this.createStatus(config, "failed", {
    error: displayMessage,
    failureKind,
    ...(responseDiagnostic?.serverRequestId
      ? { serverRequestId: responseDiagnostic.serverRequestId }
      : {}),
  });
  const recentStderr = getRecentStderr?.();
  const mcpTransportPid = getStdioTransportPid(transport);
  await this.closeClientAndTransport(name, client, transport);
  if (!this.isCurrentConnection(name, generation)) {
    return this.records.get(name)?.status ?? status;
  }
  this.records.set(name, { config, status, tools: [] });
  this.logger?.warn("MCP server connection failed", {
    ...this.connectionContext,
    connectDurationMs,
    durationMs: Date.now() - startedAt,
    error: displayMessage,
    event: "mcp.server.failed",
    listToolsDurationMs,
    mcpServerName: name,
    ...(officialAuthKind ? { officialAuthKind } : {}),
    ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
    status: "failed",
    ...(recentStderr ? { stderr: recentStderr } : {}),
    transport: config.type,
  });
  return status;
}

export async function createTransport(
  this: NodeMcpAdapterContext,
  config: McpServerConfig,
  serverName: string,
  generation: number,
  _oauthAuthorizationTimeoutMs?: number,
  workingDirectory?: string,
  signal?: AbortSignal,
): Promise<{ transport: McpTransport }> {
  if (config.type === "stdio") {
    return {
      transport: new ProcessTreeStdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd
          ? resolve(workingDirectory ?? this.workingDirectory ?? process.cwd(), config.cwd)
          : (workingDirectory ?? this.workingDirectory),
        env: {
          ...buildMcpStdioEnv({ env: this.env, network: this.network }),
          ...config.env,
        },
        stderr: "pipe",
        ...(isOfficialAuthConfig(config) && config.official
          ? {
              requestMetaProvider: async () => {
                const authMeta = await this.resolveOfficialStdioAuthMeta(
                  serverName,
                  config,
                  signal,
                );
                return authMeta ? { [OFFICIAL_MCP_AUTH_META_KEY]: authMeta } : undefined;
              },
            }
          : {}),
      }),
    };
  }

  const fetch = createMcpTransportFetch({
    env: this.env,
    network: this.network,
  });
  if (config.type === "http") {
    const officialAuthFetch = this.createOfficialAuthFetch(config, serverName, generation);
    return {
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        // 官方鉴权路径下 authProvider 必为 undefined：不落 OAuth 凭据、
        // 不起 localhost 回调 server、401/403 不转授权流程。
        authProvider: this.createOAuthClientProvider(serverName, config),
        fetch: officialAuthFetch ?? fetch,
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    };
  }

  return {
    transport: new SSEClientTransport(new URL(config.url), {
      authProvider: this.createOAuthClientProvider(serverName, config),
      fetch,
      requestInit: config.headers ? { headers: config.headers } : undefined,
    }),
  };
}

export function attachStdioLogging(
  this: NodeMcpAdapterContext,
  name: string,
  transport: McpTransport,
): () => string | undefined {
  const stderrBuffer = createBoundedTextBuffer(MCP_STDIO_STDERR_LOG_MAX_CHARS);
  const stderr = (
    transport as {
      stderr?: { on(event: "data", handler: (chunk: Buffer) => void): void };
    }
  ).stderr;
  stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrBuffer.append(text);
    this.logger?.debug("MCP stdio stderr", {
      event: "mcp.stdio.stderr",
      mcpServerName: name,
      stderr: sanitizeMcpStdioStderr(text).slice(0, MCP_STDIO_STDERR_LOG_MAX_CHARS),
    });
  });
  return () => {
    const text = stderrBuffer.read();
    if (!text) return undefined;
    // 生产日志里单独的 Connection closed 无法定位 stdio MCP 子进程退出原因。
    // 只在失败事件附带尾部 stderr，并先脱敏，避免把凭据或高频输出写入生产日志。
    return sanitizeMcpStdioStderr(text).slice(-MCP_STDIO_STDERR_LOG_MAX_CHARS);
  };
}

export async function closeRecord(this: NodeMcpAdapterContext, name: string): Promise<void> {
  const record = this.records.get(name);
  if (!record) return;
  record.abortController?.abort(new Error(`MCP server ${name} connection closed`));
  if (!record.client && !record.transport) return;
  await this.closeClientAndTransport(name, record.client, record.transport);
}

export async function closeClientAndTransport(
  this: NodeMcpAdapterContext,
  name: string,
  client?: McpClient,
  transport?: McpTransport,
): Promise<void> {
  const startedAt = Date.now();
  const mcpTransportPid = getStdioTransportPid(transport);
  // 主动关闭前先摘掉 connection_lost 监听，避免正常回收被误报为意外断连。
  if (client) client.onclose = undefined;
  // MCP SDK close 只保证直接 stdio 子进程退出，npx/npm wrapper 拉起的 MCP server
  // 或 chrome-devtools-mcp watchdog 可能残留；这里先按进程树显式回收，再走 SDK close 清理协议状态。
  await this.terminateStdioProcessTree(name, transport);

  try {
    await client?.close();
  } catch (error) {
    this.logger?.debug("MCP client close failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.client.close.failed",
      mcpServerName: name,
    });
  }

  try {
    await transport?.close();
  } catch (error) {
    this.logger?.debug("MCP transport close failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.transport.close.failed",
      mcpServerName: name,
    });
  }
  if (
    this.connectionContext &&
    transport instanceof ProcessTreeStdioClientTransport &&
    !transport.processAlive
  ) {
    this.telemetry?.recordProcessClosed({
      connectionId: this.connectionContext.mcpConnectionId,
    });
  }
  this.logger?.info("MCP server closed", {
    ...this.connectionContext,
    durationMs: Date.now() - startedAt,
    event: "mcp.server.closed",
    mcpServerName: name,
    ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
    status: "completed",
  });
}

export async function terminateStdioProcessTree(
  this: NodeMcpAdapterContext,
  name: string,
  transport?: McpTransport,
): Promise<void> {
  const pid = getStdioTransportPid(transport);
  if (pid == null) return;

  try {
    await terminateMcpStdioProcessTree(pid);
  } catch (error) {
    this.logger?.warn("MCP stdio process tree cleanup failed", {
      ...this.connectionContext,
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.stdio.process_tree_cleanup.failed",
      mcpServerName: name,
      mcpTransportPid: pid,
      pid,
      status: "failed",
    });
  }
}
