import type { ModelStepRequestOptions } from "./model-step-contract.js";
import { beginLocalTurnPreparation } from "@zcode/contracts";

import { SessionEventType, createPartId } from "../deps.js";

import type { MessageId, Model, ModelToolContract, TraceContext } from "../deps.js";

import { type RuntimeMessageEntry } from "../../agent/message-history.js";

import type { DrainedPendingInputDiagnostics, RunModelTextRequestOptions } from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

import type { RegularTurnLoopState } from "./turn-loop-state.js";

export async function persistModelStepStart(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: ModelStepRequestOptions,
  modelTraceContext: TraceContext,
  assistantMessageId: MessageId,
  assistantCreatedAt: number,
  model: Model,
  querySource: string,
) {
  this.logModelRequestSteeringContext({
    activeTurn: state.activeTurn,
    drained: options.drainedSteerForNextRequest,
    messages: options.messages,
    modelStepCount: state.modelStepCount,
    traceContext: modelTraceContext,
  });
  const finishPersistence = beginLocalTurnPreparation(modelTraceContext, "persistence");
  await this.persistAssistantMessage(
    assistantMessageId,
    state.currentUserMessageId,
    assistantCreatedAt,
    undefined,
    modelTraceContext,
    model,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID: assistantMessageId,
      type: "step-start",
    },
    modelTraceContext,
  );

  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      // 自动续写提示只属于本次请求，不应写入持久化的 ModelRequest 轨迹。
      messages: options.recordedMessages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource,
      toolCount: options.tools.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  state.events.push(modelRequestEvent);
  finishPersistence();
}
