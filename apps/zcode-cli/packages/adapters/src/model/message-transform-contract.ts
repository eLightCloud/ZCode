import type { ModelMessage as AiSdkModelMessage, ToolResultPart } from "ai";
import type { ModelInputFormat } from "@zcode/contracts";

// 适配器内部的唯一数据形状，调用方不从实现反向取型。
export interface AiSdkMessageTransformOptions {
  toolSearchEnabled?: boolean;
  apiFormat?: string;
  providerOptions?: Record<string, unknown>;
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "gateway" | "custom";
  stripMedia?: boolean;
  inputFormat?: ModelInputFormat;
}

export type AiSdkAssistantMessage = Extract<AiSdkModelMessage, { role: "assistant" }>;

export type AiSdkAssistantContent = AiSdkAssistantMessage["content"];

export type AiSdkAssistantContentPart = Extract<AiSdkAssistantContent, unknown[]>[number];

export type AiSdkToolResultOutput = ToolResultPart["output"];

export type AiSdkProviderOptions = NonNullable<
  Extract<AiSdkModelMessage, { role: "system" }>["providerOptions"]
>;

export type AiSdkAssistantTransformOptions = AiSdkMessageTransformOptions & {
  stripOpenAiResponsesStoredReasoning?: boolean;
};

export type AiSdkUserContent = Extract<AiSdkModelMessage, { role: "user" }>["content"];
