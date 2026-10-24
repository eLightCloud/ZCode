import type { ModelNetworkStatusEvent, ModelTransportKind, ModelRequestSessionType as ModelRequestSessionTypeValue, QueryId, ResolvedModelApiCallObservation, TraceId } from "@zcode/contracts";
import type { ResolvedAiSdkModel } from "./runner-runtime.js";

// 适配器内部的唯一数据形状，调用方不从实现反向取型。
export interface ModelStatusContext {
  traceId: TraceId;
  queryId?: QueryId;
  sessionId?: ModelNetworkStatusEvent["sessionId"];
  turnId?: ModelNetworkStatusEvent["turnId"];
  parentSessionId?: ModelNetworkStatusEvent["parentSessionId"];
  toolCallId?: string;
  spanId?: string;
  parentSpanId?: string;
  querySource?: string;
  requestId: string;
  providerId: ResolvedAiSdkModel["providerId"];
  modelId: ResolvedAiSdkModel["modelId"];
  modelRequestSessionType: ModelRequestSessionTypeValue;
  baseURL?: string;
  providerKind?: string;
  transport: ModelTransportKind;
  maxAttempts: number;
  streamRecovery?: ModelNetworkStatusEvent["streamRecovery"];
  modelCall: ResolvedModelApiCallObservation;
}
