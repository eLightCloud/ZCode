import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type ToolExecutionSpanWriter,
} from "@zcode/contracts";

import type { TraceContext, TurnId } from "@zcode/contracts";

import { createErrorResult } from "./errors.js";

import { emitToolCallError } from "./events.js";

import type { ToolExecutorDeps } from "./types.js";

import type { ExecutableToolCall } from "../types.js";

export async function rejectUnregisteredTool(
  toolCall: ExecutableToolCall,
  emptyToolName: boolean,
  deps: ToolExecutorDeps,
  traceContext: TraceContext,
  turnId: TurnId | undefined,
  telemetry: ToolExecutionSpanWriter | undefined,
) {
  const result = createErrorResult(
    toolCall,
    createCoreError(
      CoreErrorType.ToolNotFound,
      emptyToolName
        ? "Model returned an invalid tool call: tool name is empty."
        : `Tool not found: ${toolCall.name}`,
      {
        context: { toolCallId: toolCall.id, toolName: toolCall.name },
        recoverable: false,
      },
    ),
  );
  if (emptyToolName) {
    // 空名在 admission 阶段停止会让模型永远收不到配对结果。复用
    // registry-miss 生命周期，但 provider 内容严格保留模型返回的原始空白名称。
    result.modelContent = `<tool_use_error>Error: No such tool available: ${toolCall.name}</tool_use_error>`;
  }
  // registry miss 发生在 handler/ToolCallStarted 之前；旧代码只把失败
  // 返回给 provider，没有发布 ToolCallError，V4 tool row 因而永久停在 inputStreaming。
  await emitToolCallError(
    deps,
    toolCall.id,
    traceContext,
    turnId,
    result.error,
    undefined,
    // 未注册的工具没有可信插件归属，不能采用客户端自报的身份。
    undefined,
  );
  deps.logger?.warn("Tool call rejected because the tool is not registered", {
    ...traceContextToLogContext(traceContext),
    event: "tool.call.not_found",
    module: "core.tool.executor",
    status: "failed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });
  telemetry?.finishFailed("lookup", "configuration", result.error);
  return result;
}
