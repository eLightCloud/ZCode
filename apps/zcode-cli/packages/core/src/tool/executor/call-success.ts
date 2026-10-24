import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type ToolExecutionSpanWriter,
} from "@zcode/contracts";

import {
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  attestOfficialCuaFrameContent,
} from "@zcode/zcode-cua/frame-contract";

import { hasOfficialCuaFrameAuthority } from "../../mcp/image-normalization.js";

import type { SkillTelemetryMetadata, TraceContext, TurnId } from "@zcode/contracts";

import type { ToolExecutionResult } from "../types.js";

import type { ToolEntry } from "../types.js";

import type { BackgroundTaskTracker } from "./background-tasks.js";

import { emitToolCallResult } from "./events.js";

import { runPostToolUseHooks } from "./hook-flow.js";

import { createToolResultDisplay } from "./result-display.js";

import { appendHookAdditionalContexts, serializeOutput } from "./result-serialization.js";

import { withTerminalToolTurnStop } from "./turn-control.js";

import { mergeToolExecutionTelemetry, readToolExecutionTelemetry } from "../handlers/tool-perf.js";

import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";

import type { ExecutableToolCall } from "../types.js";

import { HookRunResult } from "../../hooks/types.js";

export async function completeSuccessfulToolCall(
  entry: ToolEntry,
  output: unknown,
  handlerState: {
    readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];
    skillTelemetryMetadata: SkillTelemetryMetadata | undefined;
    failureStage: "handler" | "serialize" | "post_hook";
  },
  deps: ToolExecutorDeps,
  traceContext: TraceContext,
  canonicalToolCall: ExecutableToolCall,
  executionAbortController: AbortController,
  executionInput: unknown,
  options: ToolExecuteOptions | undefined,
  preToolHookResult: HookRunResult,
  permissionWaitMs: number | undefined,
  totalStartedAt: number,
  durationMs: number,
  startTime: number,
  turnId: TurnId | undefined,
  backgroundTasks: BackgroundTaskTracker,
  telemetry: ToolExecutionSpanWriter | undefined,
  pluginId: string | undefined,
) {
  const modelOutputEntry = resolveModelOutputEntry(entry, output);
  handlerState.failureStage = "serialize";
  let serialization = await serializeOutput(
    deps,
    output,
    modelOutputEntry,
    traceContext,
    canonicalToolCall.id,
    executionAbortController.signal,
  );
  handlerState.failureStage = "post_hook";
  const postToolHookResult = await runPostToolUseHooks(
    deps,
    canonicalToolCall,
    executionInput,
    output,
    serialization.artifactPath,
    traceContext,
    options?.signal,
  );
  serialization = appendHookAdditionalContexts(
    serialization,
    [...preToolHookResult.additionalContexts, ...postToolHookResult.additionalContexts],
    modelOutputEntry,
  );
  const display = createToolResultDisplay(canonicalToolCall.name, output, {
    mcp: entry.metadata.mcpPresentation,
    officialCua: entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  });
  const perf = mergeToolExecutionTelemetry(readToolExecutionTelemetry(output), {
    permissionWaitMs,
    // totalMs 是用户感知的工具生命周期：registry lookup、校验、Hook、权限等待、
    // handler、序列化与 PostToolUse。durationMs 继续只表示 handler 主执行段。
    totalMs: Date.now() - totalStartedAt,
  });

  const finalModelContent = serialization.modelContent ?? serialization.content;
  const modelContentProtection = modelOutputEntry.modelContentProtection
    ? attestOfficialCuaFrameContent(finalModelContent, modelOutputEntry.modelContentProtection)
    : undefined;
  if (
    modelOutputEntry.modelContentProtection &&
    Array.isArray(finalModelContent) &&
    finalModelContent.some((block) => block.type === "image") &&
    !modelContentProtection
  ) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Official CUA frame failed final model-content attestation",
      { recoverable: true },
    );
  }

  const result: ToolExecutionResult = withTerminalToolTurnStop(
    {
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
      success: true,
      output,
      display,
      modelContent: finalModelContent,
      ...(handlerState.readFileStateMetadata
        ? { readFileStateMetadata: handlerState.readFileStateMetadata }
        : {}),
      performance: perf,
      serialization,
      durationMs,
      startedAt: new Date(startTime),
      completedAt: new Date(),
    },
    { entry },
  );

  await emitToolCallResult(
    deps,
    canonicalToolCall,
    traceContext,
    turnId,
    serialization,
    durationMs,
    display,
    perf,
    handlerState.skillTelemetryMetadata,
    pluginId,
  );

  await backgroundTasks.trackBackgroundTask(canonicalToolCall, output, traceContext, turnId);

  deps.logger?.info("Tool call completed", {
    ...traceContextToLogContext(traceContext),
    durationMs,
    event: "tool.call.completed",
    module: "core.tool.executor",
    status: "completed",
    toolCallId: canonicalToolCall.id,
    toolName: canonicalToolCall.name,
  });

  telemetry?.setOutputBytes(serialization.returnedBytes);
  telemetry?.setOutputTruncated(serialization.truncated);
  telemetry?.finishCompleted();
  return result;
}

export function resolveModelOutputEntry(entry: ToolEntry, output: unknown): ToolEntry {
  const isSharedNodeRepl =
    entry.metadata.name === "mcp__node_repl__js" ||
    entry.metadata.mcpPresentation?.serverName === "node_repl";
  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION ||
    !isSharedNodeRepl ||
    !hasOfficialCuaFrameAuthority(output)
  ) {
    return entry;
  }
  return {
    ...entry,
    modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    resultBudget: {
      ...entry.resultBudget,
      maxInlineBytes: Math.max(entry.resultBudget.maxInlineBytes, 256 * 1024),
      maxModelBytes: Math.max(entry.resultBudget.maxModelBytes, 256 * 1024),
      strategy: "truncate",
      preview: { direction: "head" },
    },
  };
}
