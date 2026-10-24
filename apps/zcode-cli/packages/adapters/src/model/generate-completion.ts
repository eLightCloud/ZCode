import { createEmptyContextExceededError } from "./runner-diagnostics.js";
import type {
  ModelReasoningContentBlock,
  ModelSource,
  ModelToolCall,
  ModelToolResult,
  ModelUsage,
} from "@zcode/contracts";
import type {
  AiSdkGenerateTextOptions,
  AiSdkGenerateTextResult,
  AiSdkModelTextRequest,
} from "./runner-runtime.js";

import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";

import {
  normalizeReasoning,
  normalizeSources,
  normalizeToolCalls,
  normalizeToolResults,
  normalizeUsage,
} from "./runner-normalization.js";

import { recordGenerateTextDebug } from "./runner-debug.js";

import { getGenerateTextResultMetadata, logGenerateTextDiagnostics } from "./runner-diagnostics.js";

import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";

import { publishModelStatus } from "./runner-status.js";
import type { ModelStatusContext } from "./model-status-context.js";

import type { ResolvedAiSdkModel } from "./runner-runtime.js";

import { providerRequestIdFromHeaders } from "./runner-telemetry.js";

import { type AttemptAdmission } from "./request-admission.js";

import type { RunGenerateTextInput } from "./generate-contract.js";

import { statusPublishOptions } from "./generate-status.js";

export async function completeGenerateAttempt(
  input: RunGenerateTextInput,
  attempt: number,
  isDev: boolean,
  toolCalls: ModelToolCall[] | undefined,
  options: AiSdkGenerateTextOptions,
  recordModelIO: boolean,
  attemptRequest: AiSdkModelTextRequest,
  statusContext: ModelStatusContext,
  resolved: ResolvedAiSdkModel,
  result: AiSdkGenerateTextResult,
  startedAt: number,
  usage: ModelUsage,
  requestHeaderCount: number,
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string>,
  admission: AttemptAdmission,
  text: string,
  reasoning: ModelReasoningContentBlock[] | undefined,
  toolResults: ModelToolResult[] | undefined,
  sources: ModelSource[] | undefined,
) {
  const completedAt = Date.now();

  recordGenerateTextDebug({
    modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
    attempt,
    debugDir: input.debugDir,
    isDev,
    normalizedToolCalls: toolCalls,
    options,
    recordModelIO,
    request: attemptRequest,
    requestId: statusContext.requestId,
    resolved,
    result,
    startedAt,
  });
  logGenerateTextDiagnostics({
    attempt,
    completedAt,
    logger: input.logger,
    result,
    statusContext,
    startedAt,
    toolCallCount: toolCalls?.length ?? 0,
    usage,
  });
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      durationMs: completedAt - startedAt,
      finishReason: result.finishReason,
      requestHeaderCount,
      requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      providerRequestId: providerRequestIdFromHeaders(responseHeaders),
      timestamp: new Date(completedAt).toISOString(),
      type: "model_request_completed",
      usage,
    },
    statusPublishOptions(input, admission),
  );

  return {
    text,
    finishReason: result.finishReason,
    usage,
    reasoning,
    toolCalls,
    toolResults,
    sources,
    providerMetadata: result.providerMetadata as Record<string, unknown> | undefined,
  };
}

export function normalizeGeneratedResponse(
  result: AiSdkGenerateTextResult,
  resolved: ResolvedAiSdkModel,
  input: RunGenerateTextInput,
) {
  const responseHeaders = sanitizeModelNetworkHeaders(
    getGenerateTextResultMetadata(result)?.response?.headers,
  );
  const providerBusinessFinishError = detectProviderBusinessFinishError({
    providerId: String(resolved.providerId),
    providerKind: resolved.providerKind,
    source: {
      finishReason: result.finishReason,
      providerMetadata: result.providerMetadata,
      rawFinishReason: (result.providerMetadata as Record<string, unknown> | undefined)
        ?.rawFinishReason,
      response: (result as unknown as { response?: unknown }).response,
    },
  });
  if (providerBusinessFinishError) {
    throw providerBusinessFinishError;
  }
  const usage = normalizeUsage(result.totalUsage ?? result.usage);
  const toolCalls = normalizeToolCalls(result, input.logger);
  const toolResults = normalizeToolResults(result, toolCalls);
  const sources = normalizeSources(result);
  const text = input.request.responseJsonSchema ? serializeStructuredOutput(result) : result.text;
  const reasoning = normalizeReasoning(result.reasoning);
  const contextError = createEmptyContextExceededError({
    finishReason: result.finishReason,
    rawFinishReason: result.rawFinishReason ?? result.providerMetadata?.rawFinishReason,
    hasAssistantContent:
      text.length > 0 ||
      (reasoning ?? []).some(
        (block) => block.text.length > 0 || Object.keys(block.providerOptions ?? {}).length > 0,
      ),
    toolCallCount: toolCalls?.length ?? 0,
    usage,
  });
  if (contextError) throw contextError;
  const reasoningLength = (reasoning ?? []).reduce((total, block) => total + block.text.length, 0);
  return {
    reasoningLength,
    text,
    toolCalls,
    usage,
    responseHeaders,
    reasoning,
    toolResults,
    sources,
  };
}

export function serializeStructuredOutput(result: unknown): string {
  const output = (result as { output?: unknown }).output;
  if (output === undefined) {
    throw new Error("Structured output is unavailable");
  }
  const serialized = JSON.stringify(output);
  if (serialized === undefined) {
    throw new Error("Structured output is unavailable");
  }
  return serialized;
}
