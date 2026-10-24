import type { ModelStreamEvent } from "@zcode/contracts";

import {
  ModelErrorCode,
  ModelProtocolError,
  ModelTransportKind as ModelTransportKindValue,
} from "@zcode/contracts";


import type { ClassifiedModelFailure } from "./failure-contract.js";

import {
  isSuspiciousStreamDiagnostics,
  isZeroOutputModelCompletion,
  logStreamDiagnostics,
} from "./runner-diagnostics.js";

import { canRetryEmptyCompletion, scheduleEmptyCompletionRetry } from "./empty-completion-retry.js";

import {
  isDevelopmentModelIOEnv,
  recordStreamTextDebug,
  shouldRecordModelIO,
} from "./runner-debug.js";

import { admitAttempt, type AttemptAdmission } from "./request-admission.js";

import { retryAttemptLoopContinues, retryBudgetMaxAttempts } from "./retry-budget.js";

import { TerminalStreamChunkError } from "./runner-retry.js";

import { admissionWaitPublishers, createStatusContext } from "./runner-status.js";

import { AccountRequestRetry } from "./account-request-retry.js";

import type { RunStreamTextInput, StreamReplayState } from "./stream-attempt-contract.js";

import { observeVisibleStreamEvent, statusPublishOptions } from "./stream-status.js";

import { failStreamAdmission, startStreamAttempt } from "./stream-attempt-start.js";

import { consumeStreamChunks } from "./stream-chunk-consumer.js";

import { applyStreamEventsToRetryBoundary } from "./stream-retry-boundaries.js";

import {
  rejectEmptyStreamBusinessFailure,
  rejectStreamBusinessFailure,
} from "./stream-business-failure.js";

import { resolveStreamResponseHeaders } from "./stream-response-headers.js";

import { completeStreamAttempt } from "./stream-attempt-completion.js";

import { resolveStreamAttemptFailure } from "./stream-attempt-failure.js";

import { releaseStreamAttempt } from "./stream-attempt-cleanup.js";

import { scheduleStreamAttemptRetry } from "./stream-retry-scheduling.js";

import { createStreamAttemptState } from "./stream-attempt-state.js";

export type {
  RunStreamTextInput,
  StreamDeliveryState,
  StreamIteratorState,
  StreamMetricState,
  StreamReplayState,
  StreamRequestState,
  StreamStatusState,
} from "./stream-attempt-contract.js";

export async function* runStreamText(input: RunStreamTextInput): AsyncGenerator<ModelStreamEvent> {
  // 重试预算档位：只放宽瞬态失败的放弃条件；
  // `emittedRetryBoundaryEvent` 之后不重试的规则不变。状态事件 maxAttempts 以 0 表示无上限。
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Sse,
  });
  const recordModelIO = shouldRecordModelIO(input.env);
  const isDev = isDevelopmentModelIOEnv(input.env);
  const replayState: StreamReplayState = {
    requestMessages: input.request.messages,
    signatureRepairAttempted: false,
    emptyCompletionRetryCount: 0,
  };

  const authRetry = new AccountRequestRetry(input.request, input.resolved, input.logger);

  for (
    let attempt = 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts +
        Number(replayState.signatureRepairAttempted) +
        authRetry.extraAttempts,
    );
    attempt += 1
  ) {
    const retryBudgetAttempt =
      attempt - Number(replayState.signatureRepairAttempted) - authRetry.extraAttempts;
    const {
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
    } = createStreamAttemptState(
      input,
      retryBudgetAttempt,
      replayState,
      baseStatusContext,
      statusMaxAttempts,
      authRetry,
      attempt,
    );

    // 进程级准入：每次尝试发出前等槽位，
    // 票据在本次尝试结束时归还（成功 / 失败 / 抛出 / 消费者放弃流都经 finally；退避 sleep 之前先归还）。
    // 等待中被取消 → 与 sleep 被取消同一条路：记 connect 阶段的 cancelled 失败，抛出。
    let admission: AttemptAdmission;
    try {
      admission = await admitAttempt({
        admission: input.request.modelRequestAdmission,
        model: {
          providerId: String(requestState.resolved.providerId),
          modelId: String(requestState.resolved.modelId),
        },
        signal: input.request.abortSignal,
        ...admissionWaitPublishers(statusState.statusContext, attempt, statusPublishOptions(input)),
      });
    } catch (admitError) {
      return await failStreamAdmission(
        attemptAbortController,
        admitError,
        input,
        statusState,
        attempt,
        startedAt,
        requestState,
        metricState,
      );
    }

    try {
      const streamResult = await startStreamAttempt(
        requestState,
        attempt,
        authRetry,
        attemptRequest,
        input,
        statusState,
        recordModelIO,
        startedAt,
        admission,
        iteratorState,
      );

      yield* consumeStreamChunks(
        iteratorState,
        attemptAbortController,
        metricState,
        statusState,
        attempt,
        requestState,
        input,
        admission,
        streamIdleTimeoutMs,
        startedAt,
        diagnostics,
        deliveryState,
        pendingRetrySafeEvents,
        repairThinkingSignatureRejection,
        authRetry,
        retryBudgetAttempt,
        toolCallAssembler,
        replayState.emptyCompletionRetryCount,
        publishVisibleMilestones,
      );

      if (deliveryState.retryScheduledFromStreamChunk) {
        if (deliveryState.offPeakQueueHoldFromStreamChunk) {
          // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试。
          attempt -= 1;
        }
        continue;
      }

      const flushedEvents = applyStreamEventsToRetryBoundary({
        emittedRetryBoundaryEvent: deliveryState.emittedRetryBoundaryEvent,
        events: toolCallAssembler.flush(),
        pendingRetrySafeEvents,
        preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
      });
      deliveryState.emittedEvent = deliveryState.emittedEvent || flushedEvents.emittedEvent;
      deliveryState.emittedRetryBoundaryEvent =
        deliveryState.emittedRetryBoundaryEvent || flushedEvents.emittedRetryBoundaryEvent;
      if (flushedEvents.visibleEvents.length > 0) {
        for (const visibleEvent of flushedEvents.visibleEvents) {
          const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
          await publishVisibleMilestones(observation);
          metricState.streamOutputCommitted =
            metricState.streamOutputCommitted || observation.outputCommitted;
          yield visibleEvent;
        }
      }

      for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
        deliveryState.emittedEvent = true;
        const observation = observeVisibleStreamEvent(pendingEvent, Date.now() - startedAt);
        await publishVisibleMilestones(observation);
        metricState.streamOutputCommitted =
          metricState.streamOutputCommitted || observation.outputCommitted;
        yield pendingEvent;
      }

      if (!deliveryState.emittedError) {
        // 自然 EOF 后合成的业务错误会通过 TerminalStreamChunkError 直接离开外层 catch；
        // compact 上下文在普通主链路为空，因此必须在合成现场显式保留 stream 阶段。
        // 先识别 provider business error，再考虑 generic empty；否则额度等
        // HTTP 200 空流会被误判成可重试的暂时性空响应。
        rejectStreamBusinessFailure(statusState, diagnostics, input, attempt);

        if (isSuspiciousStreamDiagnostics(diagnostics)) {
          // 403 JSON 等业务错误有时不会让 AI SDK 抛出 error chunk，流会以空 completion 结束；
          // 若不在 adapter 层终止，core 会误报 “Model returned no text...”。
          rejectEmptyStreamBusinessFailure(statusState, diagnostics, requestState, input, attempt);

          if (
            input.request.preserveProviderStreamBoundaries !== true &&
            isZeroOutputModelCompletion({
              finishReason: diagnostics.finishReason,
              rawFinishReason: diagnostics.rawFinishReason,
              reasoningLength: diagnostics.reasoningDeltaChars,
              textLength: diagnostics.textDeltaChars,
              toolCallCount: diagnostics.toolCallCount,
              usage: diagnostics.usage,
            }) &&
            canRetryEmptyCompletion({
              abortSignal: input.request.abortSignal,
              attempt,
              maxAttempts: input.retry.maxAttempts,
              retryCount: replayState.emptyCompletionRetryCount,
            })
          ) {
            const responseHeaders = await resolveStreamResponseHeaders(streamResult);
            const completedAt = Date.now();
            // finish 会把 retry-safe 前奏刷成可见事件；空 completion 需在
            // flush 前进入一次 adapter retry，避免 core 把第一次 attempt 当成已完成。
            logStreamDiagnostics({
              attempt,
              diagnostics,
              durationMs: completedAt - startedAt,
              emittedError: deliveryState.emittedError,
              emittedEvent: deliveryState.emittedEvent,
              logger: input.logger,
              outboundHeaders: requestState.resolved.headers,
              statusContext: statusState.statusContext,
            });
            replayState.emptyCompletionRetryCount += 1;
            await scheduleEmptyCompletionRetry({
              abortSignal: input.request.abortSignal,
              attempt,
              completedAt,
              errorPhase: "stream",
              logger: input.logger,
              requestHeaders: requestState.requestHeaders,
              requestStatusSink: input.request.statusSink,
              responseHeaders,
              retry: input.retry,
              retryBudgetAttempt,
              startedAt,
              statusContext: statusState.statusContext,
              statusSink: input.statusSink,
              streamOutputCommitted: false,
            });
            continue;
          }
        }
      }

      await completeStreamAttempt(
        attempt,
        diagnostics,
        startedAt,
        deliveryState,
        input,
        requestState,
        statusState,
        streamResult,
        metricState,
        admission,
        iteratorState,
        recordModelIO,
        isDev,
        toolCallAssembler,
        attemptRequest,
      );
      return;
    } catch (error) {
      iteratorState.attemptFailed = true;
      if (recordModelIO && requestState.options) {
        await recordStreamTextDebug({
          modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
          attempt,
          debugDir: input.debugDir,
          error,
          isDev,
          normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
          options: requestState.options,
          recordModelIO,
          request: attemptRequest,
          requestId: statusState.statusContext.requestId,
          resolved: requestState.resolved,
          result: requestState.result,
          startedAt,
        });
      }
      if (error instanceof TerminalStreamChunkError) {
        iteratorState.awaitIteratorClose = true;
        throw error.adapterError;
      }
      if (
        error instanceof ModelProtocolError &&
        error.code === ModelErrorCode.ModelRequestAuthMissing
      ) {
        // stream 在 attempt try 内解析请求鉴权，过去会把网络前的类型化
        // 鉴权缺失错误重新归一化为通用请求失败；generate 则直接保留原始协议错误。
        throw error;
      }

      const {
        retryWithAuth,
        failure,
        responseHeaders,
        retryWithRepairedHistory,
        failureDecision,
        errorPhase,
        offPeak,
      }: {
        retryWithAuth: boolean;
        failure: ClassifiedModelFailure;
        responseHeaders: Record<string, string>;
        retryWithRepairedHistory: boolean;
        failureDecision: { canRetry: boolean; context?: Record<string, unknown> };
        errorPhase: string;
        offPeak: import("./offpeak-retry.js").OffPeakFailureDecision | null;
      } = await resolveStreamAttemptFailure(
        deliveryState,
        repairThinkingSignatureRejection,
        error,
        statusState,
        statusMaxAttempts,
        authRetry,
        input,
        requestState,
        iteratorState,
        retryBudgetAttempt,
        retryBudget,
        diagnostics,
        metricState,
        replayState,
        attempt,
        startedAt,
        admission,
      );

      const discountRetry = await scheduleStreamAttemptRetry(
        retryWithAuth,
        input,
        statusState,
        attempt,
        failure,
        requestState,
        responseHeaders,
        retryWithRepairedHistory,
        admission,
        failureDecision,
        error,
        errorPhase,
        offPeak,
        retryBudgetAttempt,
        startedAt,
        metricState,
        iteratorState,
      );
      if (discountRetry) attempt -= 1;
    } finally {
      await releaseStreamAttempt(
        iteratorState,
        input,
        attemptAbortController,
        deliveryState,
        statusState,
        attempt,
        startedAt,
        requestState,
        metricState,
        admission,
      );
      attemptAbortController.cleanup();
      // 兜底归还（成功 / 抛出 / 消费者提前 return 都到这里）；正常失败路径已在 sleep 前归还，幂等。
      admission.release();
    }
  }
}
