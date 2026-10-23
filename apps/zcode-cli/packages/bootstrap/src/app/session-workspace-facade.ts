import { type MessageId } from "@zcode/contracts";

import { normalizeModelSelection } from "@zcode/provider";

import { completeAuxiliaryRegistryModelSelection } from "./provider-registry-selection.js";

import type { CreateSessionFacadeDeps, SessionFacade } from "./session-facade-contract.js";

export function createSessionWorkspaceFacade(
  deps: CreateSessionFacadeDeps,
): Pick<
  SessionFacade,
  | "readBackgroundBashOutput"
  | "cancelBackgroundTask"
  | "disconnectMcpServer"
  | "listCheckpoints"
  | "forkFromCheckpoint"
  | "sampleModel"
  | "generateWorkspaceText"
  | "testModelConnectivity"
> {
  return {
    readBackgroundBashOutput: (workId, sessionId) =>
      deps.runtime.readBackgroundBashOutput(workId, sessionId),
    cancelBackgroundTask: async (taskId, options) =>
      deps.runtime.cancelBackgroundTask(taskId, {
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    disconnectMcpServer: async (name) => {
      if (!deps.mcpPort) return undefined;
      return deps.mcpPort.disconnectServer(name);
    },
    listCheckpoints: async (options) => {
      await deps.prepareResume();
      return deps.runtime.listWorkspaceCheckpoints(options);
    },
    forkFromCheckpoint: async (options) => {
      await deps.prepareResume(options?.traceContext);
      return deps.runtime.forkWorkspaceFromCheckpoint({
        targetCheckpointId: options?.targetCheckpointId,
        targetMessageId: options?.targetMessageId as MessageId | undefined,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    sampleModel: (input, options) =>
      deps.runtime.sampleModel(input, {
        ...options,
        traceContext: options.traceContext ?? deps.traceContext,
      }),
    generateWorkspaceText: async (input, options) => {
      // 辅助文本入口只规范化模型身份；具体的最低档位由 Core 的辅助请求调用点显式决定。
      const selection =
        normalizeModelSelection(deps.providerRegistry.getView(), input.selection) ??
        input.selection;
      return await deps.runtime.generateWorkspaceText(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    testModelConnectivity: async (input, options) => {
      // 连接测试用的 Model 也要先绑定最低档位，否则严格 Factory 会先因缺档位失败。
      const selection = completeAuxiliaryRegistryModelSelection(
        deps.providerRegistry,
        input.selection,
      );
      await deps.runtime.testModelConnectivity(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
  } satisfies Partial<SessionFacade>;
}
