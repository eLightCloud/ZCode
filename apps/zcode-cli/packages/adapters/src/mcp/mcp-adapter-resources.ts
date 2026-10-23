import type {
  McpCallToolOptions,
  McpListResourceTemplatesResult,
  McpListResourcesRequest,
  McpListResourcesResult,
  McpResourceSubscriptionRequest,
} from "@zcode/contracts";

import { McpResourceSubscribeUnsupportedError } from "@zcode/contracts";

import { createMcpDeadline, remainingMcpDeadlineMs, type McpDeadline } from "./timeout.js";

import {
  DEFAULT_MCP_TIMEOUT_MS,
  MCP_NOTIFICATION_MESSAGE,
  MCP_NOTIFICATION_RESOURCES_LIST_CHANGED,
  MCP_NOTIFICATION_RESOURCES_UPDATED,
  MCP_NOTIFICATION_TOOLS_LIST_CHANGED,
} from "./mcp-adapter-contract.js";

import type { McpClient, McpServerRecord } from "./mcp-adapter-contract.js";

import type { NodeMcpAdapterContext } from "./mcp-adapter-context.js";
import { pickResourceDescriptor } from "./mcp-adapter-protocol.js";
/** `resources/list`，分页游标透传。 */

export async function listResources(
  this: NodeMcpAdapterContext,
  request: McpListResourcesRequest,
  options: McpCallToolOptions = {},
): Promise<McpListResourcesResult> {
  const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
    request.serverName,
    "resources/list",
    options,
  );
  const result = await record.client.listResources(
    request.cursor ? { cursor: request.cursor } : {},
    { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
  );
  return {
    resources: (result.resources ?? []).map((resource) => {
      const { uri, ...rest } = pickResourceDescriptor(resource);
      return { uri: uri ?? "", ...rest };
    }),
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
  };
}

export async function listResourceTemplates(
  this: NodeMcpAdapterContext,
  request: McpListResourcesRequest,
  options: McpCallToolOptions = {},
): Promise<McpListResourceTemplatesResult> {
  const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
    request.serverName,
    "resources/templates/list",
    options,
  );
  const result = await record.client.listResourceTemplates(
    request.cursor ? { cursor: request.cursor } : {},
    { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
  );
  return {
    resourceTemplates: (result.resourceTemplates ?? []).map((template) => {
      const item = template as Record<string, unknown>;
      return {
        uriTemplate: typeof item.uriTemplate === "string" ? item.uriTemplate : "",
        ...pickResourceDescriptor(item, false),
      };
    }),
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
  };
}

/**
 * 按 (serverName, uri) 计数的订阅。同一连接被多个 session 共享时只向 server 订阅一次；
 * server 没声明 resources.subscribe 能力 → McpResourceSubscribeUnsupportedError。
 */

export async function subscribeResource(
  this: NodeMcpAdapterContext,
  request: McpResourceSubscriptionRequest,
  options: McpCallToolOptions = {},
): Promise<void> {
  const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
    request.serverName,
    "resources/subscribe",
    options,
  );
  if (!record.client.getServerCapabilities()?.resources?.subscribe) {
    throw new McpResourceSubscribeUnsupportedError(request.serverName);
  }
  const { first } = this.resourceSubscriptions.add(
    request.serverName,
    request.uri,
    request.subscriberKey,
  );
  if (!first) return;
  try {
    await record.client.subscribeResource(
      { uri: request.uri },
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
  } catch (error) {
    this.resourceSubscriptions.remove(request.serverName, request.uri, request.subscriberKey);
    throw error;
  }
  this.logger?.info("MCP resource subscribed", {
    event: "mcp.resource.subscribe",
    mcpServerName: request.serverName,
    uri: request.uri,
    status: "completed",
  });
}

export async function unsubscribeResource(
  this: NodeMcpAdapterContext,
  request: McpResourceSubscriptionRequest,
  options: McpCallToolOptions = {},
): Promise<void> {
  const removed = this.resourceSubscriptions.remove(
    request.serverName,
    request.uri,
    request.subscriberKey,
  );
  if (!removed?.last) return;
  await this.unsubscribeOnServer(request.serverName, request.uri, options);
}

export async function unsubscribeResourcesBySubscriber(
  this: NodeMcpAdapterContext,
  subscriberKeyPrefix: string,
): Promise<number> {
  const released = this.resourceSubscriptions.removeByPrefix(subscriberKeyPrefix);
  for (const { serverName, uri } of released) {
    await this.unsubscribeOnServer(serverName, uri, {});
  }
  return released.length;
}

/** 登记表快照（测试 / 诊断）：serverName → uri → 订阅者数。 */

export function resourceSubscriptionCounts(
  this: NodeMcpAdapterContext,
): Record<string, Record<string, number>> {
  return this.resourceSubscriptions.counts();
}

export async function unsubscribeOnServer(
  this: NodeMcpAdapterContext,
  serverName: string,
  uri: string,
  options: McpCallToolOptions,
): Promise<void> {
  const record = this.records.get(serverName);
  if (!record?.client || record.status.status !== "connected") return;
  try {
    await record.client.unsubscribeResource({ uri }, { signal: options.signal });
    this.logger?.info("MCP resource unsubscribed", {
      event: "mcp.resource.unsubscribe",
      mcpServerName: serverName,
      uri,
      status: "completed",
    });
  } catch (error) {
    // 退订失败只记日志：登记表已清，server 多发的通知因没有订阅者会被丢弃。
    this.logger?.warn("MCP resource unsubscribe failed", {
      event: "mcp.resource.unsubscribe",
      mcpServerName: serverName,
      uri,
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    });
  }
}

/** 断连重连后按登记表重放 subscribe（A3）；单条失败不影响其它。 */

export async function replayResourceSubscriptions(
  this: NodeMcpAdapterContext,
  serverName: string,
  client: McpClient,
): Promise<void> {
  const uris = this.resourceSubscriptions.uris(serverName);
  if (uris.length === 0) return;
  if (!client.getServerCapabilities()?.resources?.subscribe) return;
  for (const uri of uris) {
    try {
      await client.subscribeResource({ uri });
    } catch (error) {
      this.logger?.warn("MCP resource subscription replay failed", {
        event: "mcp.resource.subscribe",
        mcpServerName: serverName,
        uri,
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
    }
  }
  this.logger?.info("MCP resource subscriptions replayed after reconnect", {
    event: "mcp.resource.subscribe.replayed",
    mcpServerName: serverName,
    uriCount: uris.length,
  });
}

export async function resolveForResourceRequest(
  this: NodeMcpAdapterContext,
  serverName: string,
  operation: string,
  options: McpCallToolOptions,
): Promise<{
  record: McpServerRecord & { client: McpClient };
  deadline: McpDeadline;
  timeoutMessage: string;
}> {
  const timeoutMs =
    options.timeoutMs ?? this.records.get(serverName)?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const deadline = createMcpDeadline(timeoutMs);
  const timeoutMessage = `MCP ${operation} ${serverName} timed out after ${timeoutMs}ms`;
  const record = await this.resolveConnectedRecord(
    serverName,
    deadline,
    timeoutMessage,
    options.signal,
  );
  return { record, deadline, timeoutMessage };
}

/**
 * server 主动通知。订阅类通知附上当前登记的 subscriberKey（宿主据此按会话拆分）；
 * tools/list_changed 只标记 stale，下一次 listTools 再拉；没有端口时 SDK 默认丢弃。
 */

export function installNotificationHandlers(
  this: NodeMcpAdapterContext,
  client: McpClient,
  serverName: string,
): void {
  const setNotificationHandler = (client as unknown as { setNotificationHandler?: unknown })
    .setNotificationHandler;
  if (typeof setNotificationHandler !== "function") return;
  // SDK 2.x：第一个参数是通知方法名（spec 方法直接用字符串），schema 是可选的第二个参数。
  const typed = client as unknown as {
    setNotificationHandler(method: string, handler: (notification: unknown) => void): void;
  };
  typed.setNotificationHandler(MCP_NOTIFICATION_TOOLS_LIST_CHANGED, () => {
    const record = this.records.get(serverName);
    if (record) record.toolsStale = true;
    this.toolListRevisionCounter += 1;
    this.notifications?.onNotification({ kind: "toolListChanged", serverName });
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_UPDATED, (notification) => {
    const uri = (notification as { params?: { uri?: unknown } }).params?.uri;
    if (typeof uri !== "string") return;
    this.notifications?.onNotification({
      kind: "resourceUpdated",
      serverName,
      uri,
      subscribers: this.resourceSubscriptions.subscribers(serverName, uri),
    });
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_LIST_CHANGED, () => {
    this.notifications?.onNotification({
      kind: "resourceListChanged",
      serverName,
      subscribers: this.resourceSubscriptions.allSubscribers(serverName),
    });
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_MESSAGE, (notification) => {
    const params = (notification as { params?: Record<string, unknown> }).params ?? {};
    this.notifications?.onNotification({
      kind: "loggingMessage",
      serverName,
      level: typeof params.level === "string" ? params.level : "info",
      ...(typeof params.logger === "string" ? { logger: params.logger } : {}),
      data: params.data,
    });
  });
}
