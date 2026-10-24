import {
  zcodePluginsCancelOperationParamsSchema,
  zcodeWorkspaceCancelGenerateTextParamsSchema,
} from "@zcode/shared";

import { parseParams } from "./server-types.js";

import type { ZCodeProtocolAgentServerMethodsContext } from "./protocol-server-context.js";
export function cancelPluginOperation(
  this: ZCodeProtocolAgentServerMethodsContext,
  rawParams: unknown,
): { operationId: string; cancelled: boolean } {
  const params = parseParams(zcodePluginsCancelOperationParamsSchema, rawParams);
  const controller = this.pluginOperationControllers.get(params.operationId);
  if (!controller) return { operationId: params.operationId, cancelled: false };
  // 插件同步的可取消能力必须保留在 V4 server；仅按 operationId 中止对应链路。
  controller.abort();
  this.pluginOperationControllers.delete(params.operationId);
  return { operationId: params.operationId, cancelled: true };
}

export function cancelWorkspaceGenerateText(
  this: ZCodeProtocolAgentServerMethodsContext,
  rawParams: unknown,
): { operationId: string; cancelled: boolean } {
  const params = parseParams(zcodeWorkspaceCancelGenerateTextParamsSchema, rawParams);
  const controller = this.workspaceGenerateTextControllers.get(params.operationId);
  if (!controller) return { operationId: params.operationId, cancelled: false };
  controller.abort(new DOMException("Workspace model request cancelled", "AbortError"));
  this.workspaceGenerateTextControllers.delete(params.operationId);
  return { operationId: params.operationId, cancelled: true };
}
