import type {
  McpElicitationRequest,
  McpElicitationResult,
  McpServerNotification,
} from "@zcode/contracts";

import { requestMcpElicitation as requestMcpElicitationFromClient } from "./interaction-broker.js";

import type { ZCodeProtocolRequestId } from "@zcode/shared";

import { routeMcpServerNotification } from "./mcp-ui/index.js";

import type { ZCodeProtocolAgentServerMethodsContext } from "./protocol-server-context.js";
export function resolveClientRequest(
  this: ZCodeProtocolAgentServerMethodsContext,
  id: ZCodeProtocolRequestId,
  result: unknown,
): void {
  const key = String(id);
  const pending = this.pendingClientRequests.get(key);
  if (!pending) {
    return;
  }
  this.cleanupClientRequest(pending);
  try {
    pending.resolve(pending.resultSchema.parse(result));
  } catch (error) {
    pending.reject(
      error instanceof Error ? error : new Error(`Invalid response: ${pending.method}`),
    );
  }
}

export function rejectClientRequest(
  this: ZCodeProtocolAgentServerMethodsContext,
  id: ZCodeProtocolRequestId,
  error: Error,
): void {
  const key = String(id);
  const pending = this.pendingClientRequests.get(key);
  if (!pending) {
    return;
  }
  this.cleanupClientRequest(pending);
  pending.reject(error);
}

/**
 * 官方 MCP 身份头端口所需的最小上下文。
 * MCP 连接池的构造早于 server，需要在 server 就绪后回填闭包持有的引用——
 * 与 v4Gateway 同样的构造顺序收口方式。只暴露 requestClient，不外泄整个 context。
 */
/** MCP server 发起的 elicitation/create → 用户提问。 */

export function requestMcpElicitation(
  this: ZCodeProtocolAgentServerMethodsContext,
  request: McpElicitationRequest,
  options?: { signal?: AbortSignal },
): Promise<McpElicitationResult> {
  return requestMcpElicitationFromClient(this.context, request, options);
}

/** MCP server 通知 → 会话 live 事件 / agent 日志。 */

export function handleMcpNotification(
  this: ZCodeProtocolAgentServerMethodsContext,
  notification: McpServerNotification,
): void {
  routeMcpServerNotification(this.context, notification);
}
