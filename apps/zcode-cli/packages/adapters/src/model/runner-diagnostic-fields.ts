import type { ModelUsage } from "@zcode/contracts";
import { asRecord } from "./runner-record.js";
import { stringProperty } from "./runner-record.js";

import type { StreamDiagnostics } from "./stream-diagnostics-contract.js";
import { ModelErrorCode } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";

export function summarizeProviderBody(body: unknown): Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  if (body === null) return { type: "null" };

  if (typeof body === "string") {
    return {
      length: body.length,
      preview: body.slice(0, 500),
      type: "string",
    };
  }

  if (typeof body !== "object") {
    return {
      type: typeof body,
      value: summarizeScalar(body),
    };
  }

  const record = body as Record<string, unknown>;
  return {
    code: summarizeScalar(record.code),
    error: summarizeProviderError(record.error),
    keys: objectKeys(record),
    message: summarizeScalar(record.message),
    msg: summarizeScalar(record.msg),
    status: summarizeScalar(record.status),
    success: typeof record.success === "boolean" ? record.success : undefined,
    type: Array.isArray(body) ? "array" : "object",
  };
}

export function summarizeProviderError(error: unknown): unknown {
  if (error === undefined || error === null || typeof error !== "object") {
    return summarizeScalar(error);
  }

  const record = error as Record<string, unknown>;
  return {
    code: summarizeScalar(record.code),
    keys: objectKeys(record),
    message: summarizeScalar(record.message),
    type: summarizeScalar(record.type),
  };
}

export function summarizeStreamChunk(chunk: unknown): Record<string, unknown> {
  const record = asRecord(chunk);
  return {
    chunkKeys: objectKeys(record),
    chunkType: stringProperty(record, "type") ?? typeof chunk,
    finishReason: summarizeScalar(record.finishReason),
    rawFinishReason: summarizeScalar(record.rawFinishReason),
  };
}

export function summarizeModelUsage(usage?: ModelUsage): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    serverToolUse: usage.serverToolUse,
    totalTokens: usage.totalTokens,
  };
}

export function summarizeScalar(value: unknown): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
}

export function objectKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.keys(value).slice(0, 20);
}

export function isSuspiciousStreamDiagnostics(diagnostics: StreamDiagnostics): boolean {
  return isSuspiciousModelCompletion({
    finishReason: diagnostics.finishReason,
    textLength: diagnostics.textDeltaChars,
    toolCallCount: diagnostics.toolCallCount,
    usage: diagnostics.usage,
  });
}

const CONTEXT_LIMIT_FINISH_REASONS = new Set([
  "context_exceeded",
  "context_length_exceeded",
  "context_window_exceeded",
  "model_context_exceeded",
  "model_context_window_exceeded",
  "prompt_too_long",
]);

const EMPTY_COMPLETION_RETRY_EXCLUSIONS = new Set([
  ...CONTEXT_LIMIT_FINISH_REASONS,
  "refusal",
  "content-filter",
  "content_filter",
]);

export function createEmptyContextExceededError(input: {
  finishReason?: string;
  rawFinishReason?: unknown;
  hasAssistantContent: boolean;
  toolCallCount: number;
  usage?: ModelUsage;
}): AiSdkModelAdapterError | undefined {
  // 只转换无有效输出的明确超窗；任何 partial 都保留给原调用方，不能迁移 Core 的续写策略。
  if (input.hasAssistantContent || input.toolCallCount > 0) return undefined;
  if (
    ![input.finishReason, input.rawFinishReason].some(
      (reason) =>
        typeof reason === "string" && CONTEXT_LIMIT_FINISH_REASONS.has(reason.trim().toLowerCase()),
    )
  )
    return undefined;
  // 在成功终态前走既有失败链，避免无效 Continue 和遗留的成功请求身份；已报告用量随失败结算。
  return new AiSdkModelAdapterError(
    ModelErrorCode.ModelContextExceeded,
    "Model request exceeded the provider context window.",
    {
      usage: input.usage,
      context: { finishReason: input.finishReason, rawFinishReason: input.rawFinishReason },
    },
  );
}

function excludesEmptyCompletionRetry(value: unknown): boolean {
  return (
    typeof value === "string" && EMPTY_COMPLETION_RETRY_EXCLUSIONS.has(value.trim().toLowerCase())
  );
}

export function isZeroOutputModelCompletion(input: {
  finishReason?: string;
  rawFinishReason?: unknown;
  reasoningLength: number;
  textLength: number;
  toolCallCount: number;
  usage?: ModelUsage;
}): boolean {
  // 上下文超限、拒绝和内容过滤已有明确原因；此前零输出会先被原样重试。
  // 这三类结果直接交给 core；普通输出额度和其他原因保持现有空响应重试边界。
  if (
    excludesEmptyCompletionRetry(input.finishReason) ||
    excludesEmptyCompletionRetry(input.rawFinishReason)
  ) {
    return false;
  }
  return (
    input.finishReason !== undefined &&
    input.reasoningLength === 0 &&
    isSuspiciousModelCompletion({
      finishReason: input.finishReason,
      textLength: input.textLength,
      toolCallCount: input.toolCallCount,
      usage: input.usage,
    })
  );
}

export function isSuspiciousModelCompletion(input: {
  finishReason?: string;
  textLength: number;
  toolCallCount: number;
  usage?: ModelUsage;
}): boolean {
  return (
    input.textLength === 0 &&
    input.toolCallCount === 0 &&
    isNonStopFinish(input.finishReason) &&
    isZeroUsage(input.usage)
  );
}

export function isNonStopFinish(finishReason?: string): boolean {
  const normalized = finishReason?.trim().toLowerCase();
  return normalized !== "stop" && normalized !== "tool-calls" && normalized !== "tool_calls";
}

export function isZeroUsage(usage?: ModelUsage): boolean {
  if (!usage) return true;
  const serverToolUse =
    (usage.serverToolUse?.webSearchRequests ?? 0) + (usage.serverToolUse?.webFetchRequests ?? 0);
  if (serverToolUse > 0) return false;
  const total =
    usage.totalTokens ??
    (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0) +
      (usage.reasoningTokens ?? 0);
  return total === 0;
}

export function toLogError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
