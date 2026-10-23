import { createLinkedAbortController } from "./stream-idle-timeout.js";

import type { ModelStreamEvent } from "@zcode/contracts";

import { readNextWithStreamIdleTimeout } from "./stream-idle-timeout.js";

import { StreamDiagnostics, isZeroOutputModelCompletion } from "./runner-diagnostics.js";

import { canRetryEmptyCompletion } from "./empty-completion-retry.js";

import { type AttemptAdmission } from "./request-admission.js";

import { publishModelStatus, publishModelTelemetryMilestone } from "./runner-status.js";

import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";

import { AccountRequestRetry } from "./account-request-retry.js";

import type {
  RunStreamTextInput,
  StreamDeliveryState,
  StreamIteratorState,
  StreamMetricState,
  StreamRequestState,
  StreamStatusState,
} from "./stream-attempt-contract.js";

import { observeVisibleStreamEvent, statusPublishOptions } from "./stream-status.js";

import { handleStreamChunk } from "./stream-chunk-handling.js";

import { compactDirectToolCallCommitEvent } from "./stream-retry-boundaries.js";

export async function* consumeStreamChunks(
  iteratorState: StreamIteratorState,
  attemptAbortController: ReturnType<typeof createLinkedAbortController>,
  metricState: StreamMetricState,
  statusState: StreamStatusState,
  attempt: number,
  requestState: StreamRequestState,
  input: RunStreamTextInput,
  admission: AttemptAdmission,
  streamIdleTimeoutMs: number,
  startedAt: number,
  diagnostics: StreamDiagnostics,
  deliveryState: StreamDeliveryState,
  pendingRetrySafeEvents: ModelStreamEvent[],
  repairThinkingSignatureRejection: (error: unknown) => boolean,
  authRetry: AccountRequestRetry,
  retryBudgetAttempt: number,
  toolCallAssembler: StreamingToolCallAssembler,
  emptyCompletionRetryCount: number,
  publishVisibleMilestones: (observation: { contentMs?: number; textMs?: number }) => Promise<void>,
) {
  while (true) {
    const next = await readNextWithStreamIdleTimeout(iteratorState.streamIterator!, {
      abortController: attemptAbortController.controller,
      onTimeout: async (error) => {
        metricState.streamStallCount += 1;
        metricState.streamMaxIdleMs = Math.max(metricState.streamMaxIdleMs, error.idleMs);
        await publishModelStatus(
          {
            ...statusState.statusContext,
            attempt,
            idleMs: error.idleMs,
            message: error.message,
            requestHeaderCount: requestState.requestHeaderCount,
            requestHeaders: requestState.requestHeaders,
            timeoutMs: error.timeoutMs,
            timestamp: new Date().toISOString(),
            type: "model_stream_stalled",
          },
          statusPublishOptions(input, admission),
        );
      },
      timeoutMs: streamIdleTimeoutMs,
    });
    if (next.done) {
      iteratorState.streamReachedNaturalEnd = true;
      break;
    }
    if (metricState.timeToFirstProviderEventMs === undefined) {
      metricState.timeToFirstProviderEventMs = Date.now() - startedAt;
      await publishModelTelemetryMilestone(
        {
          ...statusState.statusContext,
          attempt,
          elapsedMs: metricState.timeToFirstProviderEventMs,
          timestamp: new Date(startedAt + metricState.timeToFirstProviderEventMs).toISOString(),
          type: "model_first_provider_event",
        },
        { logger: input.logger, statusSink: input.statusSink },
      );
    }

    let event: Awaited<ReturnType<typeof handleStreamChunk>>;
    try {
      event = await handleStreamChunk({
        admission,
        attempt,
        chunk: next.value,
        diagnostics,
        emittedRetryBoundaryEvent: deliveryState.emittedRetryBoundaryEvent,
        input,
        pendingRetrySafeEvents,
        requestHeaderCount: requestState.requestHeaderCount,
        requestHeaders: requestState.requestHeaders,
        repairThinkingSignatureRejection,
        canRecoverProjectToken: (error) => authRetry.canRecoverProjectToken(error),
        retryBudgetAttempt,
        startedAt,
        statusContext: statusState.statusContext,
        toolCallAssembler,
      });
    } catch (error) {
      const directToolCommit = compactDirectToolCallCommitEvent(input.request, next.value);
      if (directToolCommit) {
        // 完整 direct tool-call 已是 provider 事件；name/input 校验即使抛错，
        // 也不能让 adapter 当作首事件前失败再次 SSE 重放。
        deliveryState.emittedRetryBoundaryEvent = true;
        for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
          deliveryState.emittedEvent = true;
          yield pendingEvent;
        }
        // 无 raw message-block provenance 的 provider 可能直接给完整 tool-call。
        // 先把 inferred block stop 交给隐藏 collector，再传播校验错误，避免 HTTP 重放。
        deliveryState.emittedEvent = true;
        yield directToolCommit;
      }
      throw error;
    }
    const shouldHoldEmptyCompletionEvents =
      !event.emittedError &&
      event.visibleEvents.some((visibleEvent) => visibleEvent.type === "finish") &&
      input.request.preserveProviderStreamBoundaries !== true &&
      isZeroOutputModelCompletion({
        finishReason: diagnostics.finishReason,
        reasoningLength: diagnostics.reasoningDeltaChars,
        textLength: diagnostics.textDeltaChars,
        toolCallCount: diagnostics.toolCallCount,
        usage: diagnostics.usage,
      }) &&
      canRetryEmptyCompletion({
        abortSignal: input.request.abortSignal,
        attempt,
        maxAttempts: input.retry.maxAttempts,
        retryCount: emptyCompletionRetryCount,
      });
    if (shouldHoldEmptyCompletionEvents) {
      // finish 会把已缓存的 start 一并刷给 core；先暂存到自然 EOF，确认这是
      // generic empty 后再重试，避免第一次 attempt 的 finish/start 泄漏到 UI。
      event.visibleEvents.length = 0;
    }
    deliveryState.emittedError = deliveryState.emittedError || event.emittedError;
    deliveryState.emittedEvent = deliveryState.emittedEvent || event.emittedEvent;
    deliveryState.emittedRetryBoundaryEvent =
      deliveryState.emittedRetryBoundaryEvent || event.emittedRetryBoundaryEvent;

    if (event.retryScheduled) {
      // SSE error chunk 的 retry 是正常控制流，不会进入 catch；
      // 若不显式标记失败，finally 会跳过旧 attempt 的 iterator/tee 清理。
      // 下一次物理请求必须等待本轮 abort 与有界清理后才能启动。
      iteratorState.attemptFailed = true;
      iteratorState.awaitIteratorClose = true;
      deliveryState.retryScheduledFromStreamChunk = true;
      deliveryState.offPeakQueueHoldFromStreamChunk = event.offPeakQueueHold;
      break;
    }
    if (event.terminalError) {
      throw event.terminalError;
    }
    if (event.visibleEvents.length > 0) {
      for (const visibleEvent of event.visibleEvents) {
        const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
        await publishVisibleMilestones(observation);
        metricState.streamOutputCommitted =
          metricState.streamOutputCommitted || observation.outputCommitted;
        yield visibleEvent;
      }
    }
  }
}
