import type {
  McpListResourceTemplatesResult,
  McpListResourcesResult,
  McpReadResourceResult,
  McpServerStatus,
  McpToolCallResult,
} from "@zcode/contracts";

import type { McpAppProvidedToolDefinition, McpAppProvidedToolExecutor } from "@zcode/core";

import type { McpAppsToolVisibility } from "@zcode/shared/mcp-apps";

export interface AppMcpApi {
  listMcpServers(): Promise<Record<string, McpServerStatus>>;

  connectMcpServer(name: string): Promise<McpServerStatus>;

  /**
   * 插件 UI：UI 发起的资源读取与工具调用，
   * 走 session 自己的 mcpPort；归属校验在 mcp-ui 处理器完成，这里不重复。
   */
  readMcpResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpReadResourceResult>;

  onMcpAppConnectionInvalidated(serverName: string, listener: () => void): () => void;

  getMcpAppConnectionSnapshot(serverName: string): { identity: string; generation: number } | null;

  callMcpToolForUi(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    options?: { signal?: AbortSignal },
  ): Promise<McpToolCallResult>;

  /**
   * 按 tools/list 的 descriptor 给出工具可见性；工具不存在返回 null。
   * mcp-ui 用它拒绝 model-only 工具的 UI 调用。
   */
  getMcpToolVisibility(
    serverName: string,
    toolName: string,
  ): Promise<readonly McpAppsToolVisibility[] | null>;

  /**
   * App-Provided Tools：用给定集合整体替换本会话的 App 工具，失效工具缓存让下一次模型请求可见。
   * 与非 App 工具重名的定义跳过。返回实际登记的模型侧名字。
   */
  replaceMcpAppProvidedTools(
    definitions: readonly McpAppProvidedToolDefinition[],
    execute: McpAppProvidedToolExecutor,
  ): string[];

  /** 页面发起的 resources/list、resources/templates/list 与订阅（订阅者身份由调用方给出）。 */
  listMcpResourcesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpListResourcesResult>;

  listMcpResourceTemplatesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpListResourceTemplatesResult>;

  subscribeMcpResourceForUi(
    serverName: string,
    uri: string,
    subscriberKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;

  unsubscribeMcpResourceForUi(
    serverName: string,
    uri: string,
    subscriberKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;

  /** 会话关闭：清掉本会话（subscriberKey 前缀）的全部订阅。 */
  unsubscribeMcpResourcesForUi(subscriberKeyPrefix: string): Promise<number>;

  /** 插件页面发起的 resources/read；与 readMcpResource 同一端口，独立入口便于审计与限流。 */
  readMcpResourceForUi(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpReadResourceResult>;

  disconnectMcpServer(name: string): Promise<McpServerStatus | undefined>;
}
