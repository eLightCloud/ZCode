import { ModelId, ModelProviderId } from "@zcode/contracts";

import { traceContextToLogContext } from "../deps.js";

import type { ModelReasoningContentBlock, ModelStreamEvent, ModelStreamingPayload, ModelToolCall, ModelUsage, ToolCallId } from "../deps.js";

import { normalizeModelToolCallsForRuntime, normalizeStreamError } from "../helpers/index.js";

import type { RunModelTextRequestOptions } from "../model-execution-types.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { getOrCreateReasoningBlock } from "./reasoning-stream.js";

export async function applyModelStreamEvent(
  this: AgentRuntimeInternal,
  event: ModelStreamEvent,
  enqueueStreamingEvent: (
    payload: Parameters<(payload: ModelStreamingPayload) => void>[0],
  ) => Promise<void>,
  options: RunModelTextRequestOptions,
  streamState: {
    text: string;
    finishReason: string;
    usage: ModelUsage;
    providerMetadata: Record<string, unknown> | undefined;
  },
  publishStreamSnapshot: () => void | undefined,
  reasoning: ModelReasoningContentBlock[],
  reasoningById: Map<string, ModelReasoningContentBlock>,
  toolInputDeltaBuffers: Map<ToolCallId, string>,
  appendToolInputDelta: (toolCallId: ToolCallId, delta: string) => Promise<void>,
  flushToolInputDelta: (toolCallId: ToolCallId) => Promise<void>,
  executionModelSelection: { providerId: ModelProviderId; modelId: ModelId },
  toolCallIds: Set<string>,
  toolCalls: ModelToolCall[],
  enqueueStreamingEventAndDrain: (
    payload: Parameters<(payload: ModelStreamingPayload) => void>[0],
  ) => Promise<void>,
  flushAllToolInputDeltas: () => Promise<void>,
) {
  switch (event.type) {
    case "start": {
      await enqueueStreamingEvent({
        assistantMessageId: options.assistantMessageId,
        delta: "",
        done: false,
        kind: "start",
      });
      break;
    }

    case "text_start": {
      await enqueueStreamingEvent({
        assistantMessageId: options.assistantMessageId,
        delta: "",
        done: false,
        kind: "text_start",
      });
      break;
    }

    case "text_delta": {
      streamState.text += event.text;
      options.onStreamTextDelta?.(event.text);
      publishStreamSnapshot();
      await enqueueStreamingEvent({
        assistantMessageId: options.assistantMessageId,
        delta: event.text,
        done: false,
        kind: "text_delta",
      });
      break;
    }

    case "text_end": {
      await enqueueStreamingEvent({
        assistantMessageId: options.assistantMessageId,
        delta: "",
        done: false,
        kind: "text_end",
      });
      break;
    }

    case "reasoning_start": {
      const block = getOrCreateReasoningBlock({
        id: event.id,
        providerMetadata: event.providerMetadata,
        reasoning,
        reasoningById,
      });
      if (event.providerMetadata) {
        block.providerOptions = event.providerMetadata;
      }
      await enqueueStreamingEvent({
        assistantMessageId: options.assistantMessageId,
        delta: "",
        done: false,
        kind: "reasoning_start",
      });
      break;
    }

    case "reasoning_delta": {
      const block = getOrCreateReasoningBlock({
        id: event.id,
        providerMetadata: event.providerMetadata,
        reasoning,
        reasoningById,
      });
      block.text += event.text;
      options.onStreamReasoningDelta?.(event.text);
      if (event.providerMetadata) block.providerOptions = event.providerMetadata;
      publishStreamSnapshot();
      await enqueueStreamingEvent({
        assistantMessageId: options.assistantMessageId,
        delta: event.text,
        done: false,
        kind: "reasoning_delta",
      });
      break;
    }

    case "reasoning_end": {
      const block = reasoningById.get(event.id);
      if (block && event.providerMetadata) {
        block.providerOptions = event.providerMetadata;
      }
      reasoningById.delete(event.id);
      await enqueueStreamingEvent({
        assistantMessageId: options.assistantMessageId,
        delta: "",
        done: false,
        kind: "reasoning_end",
      });
      break;
    }

    // 原始参数流保留包装结构；目标身份由公共准入产生，再通过工具事件交给展示投影。
    // 不从参数 delta 推测执行目标，也不为展示身份调整模型流或工具调度时序。
    case "tool_input_start": {
      const toolCallId = event.id as ToolCallId;
      toolInputDeltaBuffers.delete(toolCallId);
      this.logger?.debug("Model streaming tool input started", {
        ...traceContextToLogContext(options.traceContext),
        event: "model.streaming.tool_input_start",
        module: "core.runtime",
        providerExecuted: event.providerExecuted,
        toolCallId,
        toolName: event.toolName,
      });
      await enqueueStreamingEvent({
        assistantMessageId: options.assistantMessageId,
        delta: "",
        done: false,
        kind: "tool_input_start",
        providerExecuted: event.providerExecuted,
        toolCallId,
        toolName: event.toolName,
      });
      break;
    }

    case "tool_input_delta": {
      await appendToolInputDelta(event.id as ToolCallId, event.delta);
      break;
    }

    case "tool_input_end": {
      await flushToolInputDelta(event.id as ToolCallId);
      this.logger?.debug("Model streaming tool input ended", {
        ...traceContextToLogContext(options.traceContext),
        event: "model.streaming.tool_input_end",
        module: "core.runtime",
        toolCallId: event.id,
      });
      await enqueueStreamingEvent({
        assistantMessageId: options.assistantMessageId,
        delta: "",
        done: false,
        kind: "tool_input_end",
        toolCallId: event.id as ToolCallId,
      });
      break;
    }

    case "tool_call": {
      const [toolCall] =
        normalizeModelToolCallsForRuntime([event.toolCall], {
          logger: this.logger,
          model: executionModelSelection,
          source: "streamText",
          traceContext: options.traceContext,
        }) ?? [];
      if (!toolCall) {
        break;
      }
      await flushToolInputDelta(toolCall.id as ToolCallId);
      if (toolCallIds.has(toolCall.id)) {
        // 防御原因：协议兼容或自定义 adapter 路径可能重复投递同 id 的 final tool_call；
        // runtime 按 id 去重，避免同一次响应内重复执行。
        break;
      }
      toolCallIds.add(toolCall.id);
      toolCalls.push(toolCall);
      this.logger?.debug("Model streaming tool call completed", {
        ...traceContextToLogContext(options.traceContext),
        event: "model.streaming.tool_call",
        inputKeys:
          typeof toolCall.input === "object" &&
          toolCall.input !== null &&
          !Array.isArray(toolCall.input)
            ? Object.keys(toolCall.input as Record<string, unknown>)
            : [],
        module: "core.runtime",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
      await enqueueStreamingEventAndDrain({
        assistantMessageId: options.assistantMessageId,
        delta: "",
        done: false,
        input: toolCall.input,
        kind: "tool_call",
        toolCallId: toolCall.id as ToolCallId,
        toolName: toolCall.name,
      });
      options.onStreamToolCall?.(toolCall);
      break;
    }

    case "finish": {
      streamState.finishReason = event.finishReason;
      streamState.usage = event.usage;
      streamState.providerMetadata = event.providerMetadata;
      await flushAllToolInputDeltas();
      await enqueueStreamingEventAndDrain({
        assistantMessageId: options.assistantMessageId,
        delta: "",
        done: true,
        kind: "finish",
      });
      break;
    }

    case "error": {
      await flushAllToolInputDeltas();
      await enqueueStreamingEventAndDrain({
        assistantMessageId: options.assistantMessageId,
        delta: "",
        done: true,
        kind: "error",
      });
      // AI SDK 的 error chunk 常是 ProviderBusinessError 的 plain object（如 3007），
      // 若只做 JSON.stringify 会丢失 providerCode，UI 只能看到泛化的 stream 失败文案。
      throw normalizeStreamError(event.error);
    }
  }
}
