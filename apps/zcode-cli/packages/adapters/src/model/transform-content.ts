import { modelMessageContentToText } from "@zcode/contracts";
import type { ModelMessageContent } from "@zcode/contracts";
import type { ModelMessageContentBlock } from "@zcode/contracts";
import { toStructuredToolResultText } from "./tool-result-media-projection.js";
import { dataUrlToDataContent } from "./media-transform-policy.js";
import { unsupportedInputMediaText } from "./media-transform-policy.js";

import type { AiSdkMessageTransformOptions } from "./message-transform-contract.js";

import type { AiSdkToolResultOutput } from "./message-transform-contract.js";

import type { AiSdkUserContent } from "./message-transform-contract.js";
import { ModelErrorCode } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";
// ============================================================
// Vercel AI SDK protocol transforms
// ============================================================

export function toAiSdkToolResultOutput(
  content: ModelMessageContent,
  options: AiSdkMessageTransformOptions,
  isError = false,
  textifyStructuredContent = false,
): AiSdkToolResultOutput {
  if (isError) {
    return { type: "error-text", value: modelMessageContentToText(content) };
  }

  if (typeof content === "string") return { type: "text", value: content };

  const hasToolReferences = content.some((block) => block.type === "tool_reference");
  if (textifyStructuredContent && !hasToolReferences) {
    return { type: "text", value: toStructuredToolResultText(content, options) };
  }

  if (options.stripMedia && !hasToolReferences) {
    return { type: "text", value: modelMessageContentToText(content) };
  }

  // 工具引用不是媒体：媒体降级不能把引用变成名字文本，否则服务端无法展开定义。
  const value = content.flatMap((block) => {
    if (block.type !== "tool_reference" && (textifyStructuredContent || options.stripMedia)) {
      const text = textifyStructuredContent
        ? toStructuredToolResultText([block], options)
        : modelMessageContentToText([block]);
      return text ? [{ type: "text" as const, text }] : [];
    }
    return contentBlockToAiSdkToolResultParts(block, options);
  });
  return value.length > 0
    ? { type: "content", value }
    : { type: "text", value: modelMessageContentToText(content) };
}

export function contentBlockToAiSdkToolResultParts(
  block: ModelMessageContentBlock,
  options: AiSdkMessageTransformOptions,
): Extract<AiSdkToolResultOutput, { type: "content" }>["value"] {
  switch (block.type) {
    case "text":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "tool_reference":
      if (options.providerKind !== "anthropic" || !options.toolSearchEnabled) {
        throw new AiSdkModelAdapterError(
          ModelErrorCode.InvalidModelRequest,
          "Tool references require active Anthropic ToolSearch",
        );
      }
      return [
        {
          type: "custom",
          providerOptions: { anthropic: { type: "tool-reference", toolName: block.toolName } },
        },
      ];

    case "reasoning":
      return [];

    case "image": {
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) {
        return [
          { type: "text", text: "ERROR: Image file is empty or corrupted. Inform the user." },
        ];
      }
      return [{ type: "image-data", data: data.data, mediaType: block.mediaType }];
    }

    case "video": {
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      // AI SDK tool result part 无 video 变体：视频媒体统一由 tool-result-media-projection
      // 拆成后置 user part（toolResultHasVideoMedia 对含 video 的 tool result 在所有
      // provider kind 上强制 textify），这里不产出内嵌 part。
      return [];
    }

    case "file": {
      if (block.text !== undefined && block.text.length > 0) {
        return [{ type: "text", text: block.text }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = block.dataUrl ? dataUrlToDataContent(block.dataUrl) : undefined;
      if (data) {
        return [
          {
            type: "file-data",
            data: data.data,
            mediaType: block.mediaType,
            ...(block.name ? { filename: block.name } : {}),
          },
        ];
      }
      return [{ type: "text", text: modelMessageContentToText([block]) }];
    }

    case "resource_link":
      return [{ type: "text", text: modelMessageContentToText([block]) }];
  }
}

export const EMPTY_USER_CONTENT_FALLBACK = "(no content)";

export function toAiSdkUserContent(
  content: ModelMessageContent,
  options: AiSdkMessageTransformOptions,
): AiSdkUserContent {
  // 附件-only query 拆出 prompt attachment 后可能留下空 user
  // content，空白占位又可能被 provider trim 后视为缺失 prompt。只在 wire
  // 序列化边界使用固定 fallback，避免改写 session 事实、UI 可见 query 和标题种子。
  if (typeof content === "string") return content || EMPTY_USER_CONTENT_FALLBACK;

  const parts = content.flatMap((block) => contentBlockToAiSdkUserParts(block, options));
  return parts.length > 0 ? parts : EMPTY_USER_CONTENT_FALLBACK;
}

export function contentBlockToAiSdkUserParts(
  block: ModelMessageContentBlock,
  options: AiSdkMessageTransformOptions,
): Extract<AiSdkUserContent, unknown[]> {
  switch (block.type) {
    case "tool_reference":
      throw new AiSdkModelAdapterError(
        ModelErrorCode.InvalidModelRequest,
        "Tool references must appear inside tool results",
      );
    case "text":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "reasoning":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "image": {
      if (options.stripMedia) {
        return [{ type: "text", text: modelMessageContentToText([block]) }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) {
        return [
          {
            type: "text",
            text: "ERROR: Image file is empty or corrupted. Inform the user.",
          },
        ];
      }
      return [{ type: "image", image: data.data, mediaType: block.mediaType }];
    }

    case "video": {
      if (options.stripMedia) {
        return [{ type: "text", text: modelMessageContentToText([block]) }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) {
        return [
          {
            type: "text",
            text: "ERROR: Video file is empty or corrupted. Inform the user.",
          },
        ];
      }
      // AI SDK 无 video part 类型；mediaType 为自由 string，video/* file part 由
      // patch 后的 @ai-sdk/openai-compatible / @ai-sdk/anthropic 转成 video_url / video block。
      return [{ type: "file", data: data.data, mediaType: block.mediaType }];
    }

    case "file": {
      if (block.text !== undefined && block.text.length > 0) {
        return [{ type: "text", text: block.text }];
      }
      if (options.stripMedia) {
        return [{ type: "text", text: modelMessageContentToText([block]) }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = block.dataUrl ? dataUrlToDataContent(block.dataUrl) : undefined;
      if (data) {
        return [
          {
            type: "file",
            data: data.data,
            filename: block.name,
            mediaType: block.mediaType,
          },
        ];
      }
      return [{ type: "text", text: modelMessageContentToText([block]) }];
    }

    case "resource_link":
      return [{ type: "text", text: modelMessageContentToText([block]) }];
  }
}
