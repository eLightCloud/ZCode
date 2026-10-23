// ============================================================
// Vercel AI SDK protocol transforms
// ============================================================

import { ModelErrorCode, type ModelCacheControl } from "@zcode/contracts";

import { AiSdkModelAdapterError } from "./errors.js";

import type { AiSdkMessageTransformOptions, AiSdkProviderOptions } from "./transform.js";

export function shouldStripStoredReasoningForOpenAiResponsesStatelessReplay(
  options: AiSdkMessageTransformOptions,
): boolean {
  if (options.providerKind !== "openai") return false;
  if (resolveApiFormat(options) !== "openai-responses") return false;
  const openaiOptions = objectRecord(options.providerOptions?.openai);
  if (typeof openaiOptions.previousResponseId === "string") return false;
  if (typeof openaiOptions.conversation === "string") return false;
  if (openaiOptions.store === false) return false;
  return true;
}

export function resolveApiFormat(options: AiSdkMessageTransformOptions): string | undefined {
  if (typeof options.apiFormat === "string") return options.apiFormat;
  const apiFormat = options.providerOptions?.apiFormat;
  return typeof apiFormat === "string" ? apiFormat : undefined;
}

export function projectToolNameForProvider(
  toolName: unknown,
  options: AiSdkMessageTransformOptions,
): string {
  if (typeof toolName !== "string") {
    throw new AiSdkModelAdapterError(
      ModelErrorCode.InvalidModelRequest,
      "Tool model messages require toolCallId and toolName",
    );
  }
  if (toolName.trim().length > 0) return toolName;

  const apiFormat = resolveApiFormat(options);
  if (apiFormat !== undefined) {
    return apiFormat === "anthropic-messages" ? toolName : "empty_tool_name";
  }

  // OpenAI-compatible wire 不可靠接受空 function name，但历史中的原始
  // 名称仍需保留给 Anthropic 回放；占位值只在 provider 投影边界生成。
  return options.providerKind === "anthropic" ? toolName : "empty_tool_name";
}

export function hasOpenAiStoredReasoningItemId(providerOptions: unknown): boolean {
  const openaiOptions = objectRecord(objectRecord(providerOptions).openai);
  return typeof openaiOptions.itemId === "string" && openaiOptions.itemId.length > 0;
}

export function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function providerOptionsForCacheControl(
  cacheControl: ModelCacheControl | undefined,
): { providerOptions: AiSdkProviderOptions } | Record<string, never> {
  if (!cacheControl) {
    return {};
  }

  return {
    providerOptions: {
      anthropic: {
        cacheControl: { ...cacheControl },
      },
    },
  };
}
