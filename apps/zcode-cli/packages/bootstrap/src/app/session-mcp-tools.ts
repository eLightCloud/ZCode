import type { SupportedLocale } from "@zcode/contracts";

import { resolveMcpToolVisibility } from "@zcode/contracts";

import { createMcpAppProvidedToolEntry, createMcpToolEntry, toMcpToolName } from "@zcode/core";

import type { CreateSessionFacadeDeps, SessionFacade } from "./session-facade-contract.js";

export function createSessionMcpToolsFacade(
  deps: CreateSessionFacadeDeps,
  sessionState: {
    closePromise: Promise<void> | undefined;
    currentLocale: SupportedLocale;
    appProvidedToolNames: string[];
  },
): Pick<SessionFacade, "callMcpToolForUi" | "replaceMcpAppProvidedTools" | "getMcpToolVisibility"> {
  return {
    callMcpToolForUi: async (serverName, toolName, args, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      const snapshot = deps.mcpPort.appConnectionSnapshot?.(serverName);
      if (!snapshot) throw new Error("MCP App connection is unavailable");
      const descriptor = (await deps.mcpPort.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      if (!descriptor || !resolveMcpToolVisibility(descriptor).includes("app"))
        throw new Error("Tool is not available to this App");
      const registry = deps.runtime.getToolRegistry();
      const registered = registry
        .list()
        .map((name) => registry.get(name))
        .find(
          (entry) =>
            entry?.metadata.mcpPresentation?.serverName === serverName &&
            entry.metadata.mcpPresentation.toolName === toolName,
        );
      const entry =
        registered ??
        createMcpToolEntry(toMcpToolName(descriptor), descriptor, deps.mcpPort, false);
      const executor = deps.runtime.getToolExecutor();
      if (!executor.authorizeAppTool) throw new Error("MCP App host authorization is unavailable");
      const input = await executor.authorizeAppTool(
        { id: crypto.randomUUID(), name: entry.metadata.name, input: args ?? {} },
        entry,
        { signal: options?.signal, traceContext: deps.traceContext },
      );
      // 审批期间连接可能被替换：批准只属于原连接，执行前必须再次验证。
      options?.signal?.throwIfAborted();
      const current = deps.mcpPort.appConnectionSnapshot?.(serverName);
      if (
        !current ||
        current.identity !== snapshot.identity ||
        current.generation !== snapshot.generation
      )
        throw new Error("MCP App connection changed during authorization");
      return deps.mcpPort.callTool(
        {
          serverName,
          toolName,
          arguments: input as Record<string, unknown>,
          trace: deps.traceContext,
          runtimeScope: "main",
        },
        { signal: options?.signal, appConnection: snapshot },
      );
    },
    replaceMcpAppProvidedTools: (definitions, execute) => {
      const registry = deps.runtime.getToolRegistry();
      for (const name of sessionState.appProvidedToolNames) registry.unregister(name);
      const registered: string[] = [];
      for (const definition of definitions) {
        // 不覆盖内置 / MCP 工具：`app__` 前缀本不该冲突，冲突时以既有工具为准。
        if (registry.has(definition.modelName) || registered.includes(definition.modelName))
          continue;
        registry.register(createMcpAppProvidedToolEntry(definition, execute), {
          silentDuplicateWarning: true,
        });
        registered.push(definition.modelName);
      }
      sessionState.appProvidedToolNames = registered;
      // 同回合下一次模型请求即可见：只是让 getTools 重建缓存；工具集合没变时发给模型的内容也不变。
      deps.runtime.invalidateToolCache();
      return registered;
    },
    getMcpToolVisibility: async (serverName, toolName) => {
      if (!deps.mcpPort) return null;
      // 真相是 adapter 归一化过的 descriptor（同一份 tools/list），不另存副本。
      const descriptor = (await deps.mcpPort.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      return descriptor ? resolveMcpToolVisibility(descriptor) : null;
    },
  } satisfies Partial<SessionFacade>;
}
