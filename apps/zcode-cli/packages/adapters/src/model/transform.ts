import type { AiSdkMessageTransformOptions, AiSdkAssistantContent, AiSdkAssistantContentPart, AiSdkAssistantTransformOptions, AiSdkUserContent } from "./message-transform-contract.js";
import { type ModelMessage as AiSdkModelMessage } from "ai";
import { ModelErrorCode, modelMessageContentToText, type ModelInputMessage, type ModelMessageContent, type ModelMessageContentBlock } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";
import { providerOptionsForReasoningBlock } from "./anthropic-reasoning-metadata.js";
import { shouldTextifyStructuredToolResults, toToolResultMediaUserParts, toolResultHasVideoMedia, undeliverableFrameReferenceText } from "./tool-result-media-projection.js";
import { normalizeOpenAiCompatibleSystemMessages } from "./system-message-compat.js";
import { hasOpenAiStoredReasoningItemId, projectToolNameForProvider, providerOptionsForCacheControl, shouldStripStoredReasoningForOpenAiResponsesStatelessReplay } from "./transform-options.js";
import { toAiSdkToolResultOutput, toAiSdkUserContent } from "./transform-content.js";

export type { AiSdkMessageTransformOptions, AiSdkToolResultOutput, AiSdkProviderOptions, AiSdkUserContent } from "./message-transform-contract.js";

export function toAiSdkMessages(
  messages: ModelInputMessage[],
  options: AiSdkMessageTransformOptions = {},
): AiSdkModelMessage[] {
  const normalizedMessages =
    options.providerKind === "openai-compatible"
      ? normalizeOpenAiCompatibleSystemMessages(messages)
      : messages;
  const shouldStripOpenAiResponsesStoredReasoning =
    shouldStripStoredReasoningForOpenAiResponsesStatelessReplay(options);

  const transformedMessages: AiSdkModelMessage[] = [];
  let pendingToolMediaParts: Extract<AiSdkUserContent, unknown[]> = [];
  const textifyStructuredToolResults = shouldTextifyStructuredToolResults(options);
  const flushPendingToolMedia = () => {
    if (pendingToolMediaParts.length === 0) return;
    transformedMessages.push({ role: "user", content: pendingToolMediaParts });
    pendingToolMediaParts = [];
  };

  for (const message of normalizedMessages) {
    if (message.role !== "tool") {
      flushPendingToolMedia();
    }

    switch (message.role) {
      case "system":
        transformedMessages.push({
          role: "system",
          content: modelMessageContentToText(message.content),
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;

      case "user":
        transformedMessages.push({
          role: "user",
          content: toAiSdkUserContent(message.content, options),
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;

      case "assistant": {
        transformedMessages.push({
          role: "assistant",
          content: toAiSdkAssistantContent(message.content, message.toolCalls, {
            ...options,
            stripOpenAiResponsesStoredReasoning: shouldStripOpenAiResponsesStoredReasoning,
          }),
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;
      }

      case "tool": {
        if (!message.toolCallId || message.toolName === undefined) {
          throw new AiSdkModelAdapterError(
            ModelErrorCode.InvalidModelRequest,
            "Tool model messages require toolCallId and toolName",
            { context: { role: message.role } },
          );
        }
        const toolName = projectToolNameForProvider(message.toolName, options);
        // 含 video 的 tool result 在所有 provider kind 上都强制 textify + 后置投影：
        // AI SDK tool result part 无 video 变体，anthropic 内嵌路径同样会丢失视频内容。
        const messageTextifyToolResult =
          textifyStructuredToolResults || toolResultHasVideoMedia(message.content);

        // 通用 fail-closed：帧引用结果在媒体不可投递时整体错误化（约束：
        // 引用文本不得与"媒体不可用"占位符同现，否则 actionable frame_id 会诱导
        // 模型对未见过画面的坐标产生动作）。
        const frameReferenceFailure = undeliverableFrameReferenceText(message.content, options);

        const toolMediaParts =
          frameReferenceFailure === undefined &&
          messageTextifyToolResult &&
          message.isError !== true
            ? toToolResultMediaUserParts(message.content, {
                ...options,
                toolName,
              })
            : [];
        transformedMessages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName,
              // SDK 合并连续 tool message 时只保留首条的 providerOptions；
              // 缓存标记必须跟随具体结果块，避免批次末尾标记丢失或被移到其他结果。
              ...providerOptionsForCacheControl(message.cacheControl),
              output: frameReferenceFailure
                ? { type: "error-text", value: frameReferenceFailure }
                : toAiSdkToolResultOutput(
                    message.content,
                    options,
                    message.isError === true,
                    messageTextifyToolResult,
                  ),
            },
          ],
        });
        pendingToolMediaParts.push(...toolMediaParts);
        break;
      }
    }
  }

  flushPendingToolMedia();
  return transformedMessages;
}

function toAiSdkAssistantContent(
  content: ModelMessageContent,
  toolCalls: ModelInputMessage["toolCalls"],
  options: AiSdkAssistantTransformOptions,
): AiSdkAssistantContent {
  const toolCallParts =
    toolCalls?.map(
      (toolCall): AiSdkAssistantContentPart => ({
        type: "tool-call",
        toolCallId: toolCall.id,
        toolName: projectToolNameForProvider(toolCall.name, options),
        input: toolCall.input,
      }),
    ) ?? [];

  if (typeof content === "string" && toolCallParts.length === 0) {
    return content;
  }

  const contentParts =
    typeof content === "string"
      ? content.length > 0
        ? [{ type: "text" as const, text: content }]
        : []
      : content.flatMap((block) => contentBlockToAiSdkAssistantParts(block, options));

  return [...contentParts, ...toolCallParts];
}

function contentBlockToAiSdkAssistantParts(
  block: ModelMessageContentBlock,
  options: AiSdkAssistantTransformOptions,
): AiSdkAssistantContentPart[] {
  switch (block.type) {
    case "tool_reference":
      throw new AiSdkModelAdapterError(
        ModelErrorCode.InvalidModelRequest,
        "Tool references must appear inside tool results",
      );
    case "text":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "reasoning": {
      if (
        options.stripOpenAiResponsesStoredReasoning === true &&
        hasOpenAiStoredReasoningItemId(block.providerOptions)
      ) {
        // 部分 Responses 兼容端点不支持无 previousResponseId 时回放 store=true 的
        // reasoning item_reference；只在 Responses 无状态回放边界丢弃该引用，避免工具结果续轮变成 5xx。
        return [];
      }
      // 没有正文和 provider 元数据的流式 reasoning 空壳会在历史回放时被
      // Anthropic metadata 补全误认为有效 thinking；只在请求投影边界移除精确空壳。
      if (block.text.length === 0 && Object.keys(block.providerOptions ?? {}).length === 0) {
        return [];
      }
      const providerOptions = providerOptionsForReasoningBlock(block, options);

      return [
        {
          type: "reasoning",
          text: block.text,
          ...providerOptions,
        } as AiSdkAssistantContentPart,
      ];
    }

    case "image":
    case "video":
    case "file":
    case "resource_link": {
      const text = modelMessageContentToText([block]);
      return text.length > 0 ? [{ type: "text", text }] : [];
    }
  }
}
