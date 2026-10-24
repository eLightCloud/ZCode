import {
  CoreErrorType,
  traceContextToLogContext,
  type AgentTelemetryErrorCategory,
  type ToolExecutionSpanWriter,
} from "@zcode/contracts";

import type { SkillTelemetryMetadata, TraceContext, TurnId } from "@zcode/contracts";

import type { ToolExecutionResult } from "../types.js";

import { createErrorResult, isToolHandlerFailureError } from "./errors.js";

import { emitToolCallError } from "./events.js";

import { formatHookAdditionalContexts, runPostToolUseFailureHooks } from "./hook-flow.js";

import { withAutomationCreateLimitTurnStop } from "./turn-control.js";

import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";

import type { ExecutableToolCall } from "../types.js";

import { HookRunResult } from "../../hooks/types.js";

export async function completeFailedToolCall(
  startTime: number,
  deps: ToolExecutorDeps,
  canonicalToolCall: ExecutableToolCall,
  executionInput: unknown,
  error: unknown,
  traceContext: TraceContext,
  options: ToolExecuteOptions | undefined,
  preToolHookResult: HookRunResult,
  turnId: TurnId | undefined,
  handlerState: {
    readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];
    skillTelemetryMetadata: SkillTelemetryMetadata | undefined;
    failureStage: "handler" | "serialize" | "post_hook";
  },
  telemetry: ToolExecutionSpanWriter | undefined,
  pluginId: string | undefined,
) {
  const durationMs = Date.now() - startTime;
  const failureHookResult = await runPostToolUseFailureHooks(
    deps,
    canonicalToolCall,
    executionInput,
    error,
    traceContext,
    options?.signal,
  );
  let result = createErrorResult(
    canonicalToolCall,
    error instanceof Error ? error : new Error(String(error)),
    durationMs,
  );
  const baseModelContent = result.error
    ? isToolHandlerFailureError(error) && typeof result.modelContent === "string"
      ? result.modelContent
      : result.error.message
    : undefined;
  if (failureHookResult.additionalContexts.length > 0 && baseModelContent) {
    result.modelContent = [
      baseModelContent,
      formatHookAdditionalContexts([
        ...preToolHookResult.additionalContexts,
        ...failureHookResult.additionalContexts,
      ]),
    ].join("\n\n");
  } else if (preToolHookResult.additionalContexts.length > 0 && baseModelContent) {
    result.modelContent = [
      baseModelContent,
      formatHookAdditionalContexts(preToolHookResult.additionalContexts),
    ].join("\n\n");
  }
  result = withAutomationCreateLimitTurnStop(result, {
    error,
    toolName: canonicalToolCall.name,
  });

  // Skill 已解析成功后，serialize/post_hook 仍可能失败；错误事件也要保留
  // resolved metadata，否则失败的 Skill agent_step 无法归因到具体 skill。
  await emitToolCallError(
    deps,
    canonicalToolCall.id,
    traceContext,
    turnId,
    result.error,
    handlerState.skillTelemetryMetadata,
    pluginId,
  );

  deps.logger?.error(
    "Tool call failed",
    error instanceof Error ? error : new Error(String(error)),
    {
      ...traceContextToLogContext(traceContext),
      durationMs,
      event: "tool.call.failed",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    },
  );

  if (options?.signal?.aborted || result.error?.type === CoreErrorType.ToolCancelled) {
    telemetry?.finishCancelled("abort_signal");
  } else {
    telemetry?.finishFailed(
      handlerState.failureStage,
      errorCategoryForToolError(result.error?.type),
      // 原始异常只交给 Telemetry 做受控脱敏；result.error 是面向业务协议重新包装后的错误，
      // 不能覆盖 Trace 中用于定位根因的 source message/type/code。
      error,
    );
  }
  return result;
}

export function errorCategoryForToolError(type: string | undefined): AgentTelemetryErrorCategory {
  switch (type) {
    case CoreErrorType.ConfigurationError:
    case CoreErrorType.ToolNotFound:
      return "configuration";
    case CoreErrorType.PermissionDenied:
    case CoreErrorType.PermissionEscalation:
    case CoreErrorType.PermissionTimeout:
      return "permission";
    case CoreErrorType.InvalidInput:
      return "parse";
    case CoreErrorType.ToolCancelled:
      return "cancelled";
    case CoreErrorType.ToolTimeout:
      return "timeout";
    default:
      return "internal";
  }
}
