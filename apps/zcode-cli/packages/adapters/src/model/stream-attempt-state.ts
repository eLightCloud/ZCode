import type { AiSdkModelTextRequest } from "./runner-runtime.js";

import type { ModelStatusContext } from "./runner-status.js";

import { createLinkedAbortController } from "./stream-idle-timeout.js";

import type { ModelStreamEvent } from "@zcode/contracts";

import { resolveModelStreamIdleTimeoutMs } from "./stream-idle-timeout.js";

import { createStreamDiagnostics } from "./runner-diagnostics.js";

import { createAttemptStatusContext } from "./runner-status.js";

import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";

import { AccountRequestRetry } from "./account-request-retry.js";

import type {
  RunStreamTextInput,
  StreamDeliveryState,
  StreamIteratorState,
  StreamMetricState,
  StreamReplayState,
  StreamRequestState,
  StreamStatusState,
} from "./stream-attempt-contract.js";

import { createStreamAttemptObservers } from "./stream-attempt-observers.js";

export function createStreamAttemptState(
  input: RunStreamTextInput,
  retryBudgetAttempt: number,
  replayState: StreamReplayState,
  baseStatusContext: ModelStatusContext,
  statusMaxAttempts: (n: number) => number,
  authRetry: AccountRequestRetry,
  attempt: number,
): {
  startedAt: number;
  streamIdleTimeoutMs: number;
  deliveryState: StreamDeliveryState;
  pendingRetrySafeEvents: ModelStreamEvent[];
  diagnostics: ReturnType<typeof createStreamDiagnostics>;
  attemptAbortController: ReturnType<typeof createLinkedAbortController>;
  attemptRequest: AiSdkModelTextRequest;
  statusState: StreamStatusState;
  toolCallAssembler: StreamingToolCallAssembler;
  iteratorState: StreamIteratorState;
  requestState: StreamRequestState;
  metricState: StreamMetricState;
  repairThinkingSignatureRejection: ReturnType<
    typeof createStreamAttemptObservers
  >["repairThinkingSignatureRejection"];
  publishVisibleMilestones: ReturnType<
    typeof createStreamAttemptObservers
  >["publishVisibleMilestones"];
} {
  const startedAt = Date.now();
  // SSE idle timeout 后的重试如果仍固定首请求窗口，容易被同一段 provider 静默窗口反复打断；
  // core recovery 和 adapter 内部 retry 都统一按重试次数每次增加 30s。
  const streamIdleTimeoutMs = resolveModelStreamIdleTimeoutMs({
    baseTimeoutMs: input.streamIdleTimeoutMs,
    retryNumber: (input.request.streamIdleTimeoutRetryNumber ?? 0) + retryBudgetAttempt - 1,
  });
  const deliveryState: StreamDeliveryState = {
    emittedEvent: false,
    emittedRetryBoundaryEvent: false,
    emittedError: false,
    retryScheduledFromStreamChunk: false,
    offPeakQueueHoldFromStreamChunk: false,
  };

  const pendingRetrySafeEvents: ModelStreamEvent[] = [];
  const diagnostics = createStreamDiagnostics();
  const attemptAbortController = createLinkedAbortController(input.request.abortSignal);
  const attemptRequest = {
    ...input.request,
    abortSignal: attemptAbortController.signal,
    messages: replayState.requestMessages,
  };
  const statusState: StreamStatusState = {
    statusContext: createAttemptStatusContext(
      {
        ...baseStatusContext,
        maxAttempts: statusMaxAttempts(
          Number(replayState.signatureRepairAttempted) + authRetry.extraAttempts,
        ),
      },
      attempt,
    ),
  };
  const toolCallAssembler = new StreamingToolCallAssembler({ logger: input.logger });
  const iteratorState: StreamIteratorState = {
    streamIterator: undefined,
    streamReachedNaturalEnd: false,
    attemptFailed: false,
    awaitIteratorClose: false,
    terminalStatusPublished: false,
  };

  // 提升到 try 外,使 catch 分支也能拿到 options/result 记录失败 model-io。
  const requestState: StreamRequestState = {
    options: undefined,
    result: undefined,
    requestHeaders: {},
    requestHeaderCount: 0,
    resolved: input.resolved,
  };

  const metricState: StreamMetricState = {
    timeToFirstProviderEventMs: undefined,
    timeToFirstContentMs: undefined,
    timeToFirstTextMs: undefined,
    streamMaxIdleMs: 0,
    streamStallCount: 0,
    streamOutputCommitted: false,
  };

  const { repairThinkingSignatureRejection, publishVisibleMilestones } =
    createStreamAttemptObservers(
      replayState,
      requestState,
      input,
      attempt,
      authRetry,
      statusState,
      metricState,
      startedAt,
    );

  return {
    startedAt,
    streamIdleTimeoutMs,
    deliveryState,
    pendingRetrySafeEvents,
    diagnostics,
    attemptAbortController,
    attemptRequest,
    statusState,
    toolCallAssembler,
    iteratorState,
    requestState,
    metricState,
    repairThinkingSignatureRejection,
    publishVisibleMilestones,
  };
}
