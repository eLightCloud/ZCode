import type { AiSdkModelTextRequest, AiSdkStreamTextResult } from "./runner-runtime.js";

import type { ModelStatusContext } from "./model-status-context.js";

import type { TextStreamPart, ToolSet } from "ai";

import type { Logger, ModelInputMessage, ModelStatusSink } from "@zcode/contracts";

import { createStreamTextOptions } from "./runner-options.js";

import type { EnvRecord } from "./model-execution.js";

import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

import type { AiSdkModelRuntime, ResolvedAiSdkModel } from "./runner-runtime.js";

export type StreamFailurePhase = "request_setup" | "response_body";

export type RunStreamTextInput = {
  debugDir?: string;
  env: EnvRecord;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs: number;
  modelIoFullRetentionEnabled: boolean;
};

export type StreamDeliveryState = {
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  emittedError: boolean;
  retryScheduledFromStreamChunk: boolean;
  offPeakQueueHoldFromStreamChunk: boolean;
};

export type StreamStatusState = { statusContext: ModelStatusContext };

export type StreamIteratorState = {
  streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined;
  streamReachedNaturalEnd: boolean;
  attemptFailed: boolean;
  awaitIteratorClose: boolean;
  terminalStatusPublished: boolean;
};

export type StreamRequestState = {
  options: ReturnType<typeof createStreamTextOptions> | undefined;
  result: AiSdkStreamTextResult | undefined;
  requestHeaders: Record<string, string>;
  requestHeaderCount: number;
  resolved: ResolvedAiSdkModel;
};

export type StreamMetricState = {
  timeToFirstProviderEventMs: number | undefined;
  timeToFirstContentMs: number | undefined;
  timeToFirstTextMs: number | undefined;
  streamMaxIdleMs: number;
  streamStallCount: number;
  streamOutputCommitted: boolean;
};

export type StreamReplayState = {
  requestMessages: ModelInputMessage[];
  signatureRepairAttempted: boolean;
  emptyCompletionRetryCount: number;
};
