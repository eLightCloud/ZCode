import { ModelRetryReason } from "@zcode/contracts";

import { classifyModelFailure, type ClassifiedModelFailure } from "./failure-classifier.js";

import { unwrapRetryError } from "./failure-inspection.js";

import { type AttemptAdmission } from "./request-admission.js";

import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  toAdapterError,
} from "./runner-retry.js";

import { publishModelStatus } from "./runner-status.js";

import { modelFailureStatusFields } from "./runner-telemetry.js";

import type {
  RunStreamTextInput,
  StreamIteratorState,
  StreamMetricState,
  StreamRequestState,
  StreamStatusState,
} from "./stream-attempt-contract.js";

import { publishRetryScheduledStatus, statusPublishOptions } from "./stream-status.js";

import { OffPeakFailureDecision } from "./offpeak-retry.js";

export async function scheduleStreamAttemptRetry(
  retryWithAuth: boolean,
  input: RunStreamTextInput,
  statusState: StreamStatusState,
  attempt: number,
  failure: ClassifiedModelFailure,
  requestState: StreamRequestState,
  responseHeaders: Record<string, string>,
  retryWithRepairedHistory: boolean,
  admission: AttemptAdmission,
  failureDecision: { canRetry: boolean; context?: Record<string, unknown> },
  error: unknown,
  errorPhase: string,
  offPeak: OffPeakFailureDecision | null,
  retryBudgetAttempt: number,
  startedAt: number,
  metricState: StreamMetricState,
  iteratorState: StreamIteratorState,
) {
  if (retryWithAuth) {
    await publishRetryScheduledStatus(
      input,
      statusState.statusContext,
      attempt,
      0,
      { ...failure, retryReason: ModelRetryReason.AuthRefresh },
      requestState.requestHeaders,
      responseHeaders,
    );
    return false;
  }
  if (retryWithRepairedHistory) {
    await publishRetryScheduledStatus(
      input,
      statusState.statusContext,
      attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      requestState.requestHeaders,
      responseHeaders,
      admission,
    );
    return false;
  }

  if (!failureDecision.canRetry) {
    logRetryDelayDecision({
      attempt,
      canRetry: failureDecision.canRetry,
      failure,
      logger: input.logger,
      responseHeaders,
      statusContext: statusState.statusContext,
    });
    throw toAdapterError(error, failure, statusState.statusContext, attempt, {
      ...failureDecision.context,
      errorPhase,
    });
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(input.retry, retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt,
    canRetry: failureDecision.canRetry,
    delayMs,
    failure,
    logger: input.logger,
    responseHeaders,
    statusContext: statusState.statusContext,
  });

  await publishRetryScheduledStatus(
    input,
    statusState.statusContext,
    attempt,
    delayMs,
    failure,
    requestState.requestHeaders,
    responseHeaders,
    admission,
  );
  // 退避期间不持票：槽位让给别人，重试再准入。
  admission.release();
  try {
    await sleep(delayMs, input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.request.abortSignal);
    await publishModelStatus(
      {
        ...statusState.statusContext,
        attempt,
        durationMs: Date.now() - startedAt,
        message: sleepFailure.message,
        reason: sleepFailure.reason,
        requestHeaderCount: requestState.requestHeaderCount,
        requestHeaders: requestState.requestHeaders,
        retryable: false,
        statusCode: sleepFailure.statusCode,
        streamOutputCommitted: metricState.streamOutputCommitted,
        ...modelFailureStatusFields(sleepError, sleepFailure, "connect"),
        timestamp: new Date().toISOString(),
        type: "model_request_failed",
      },
      {
        // 退避期间票据已归还：这次取消不属于任何一次尝试，不转投票据。
        ...statusPublishOptions(input),
        failureError: unwrapRetryError(sleepError),
      },
    );
    iteratorState.terminalStatusPublished = true;
    throw toAdapterError(sleepError, sleepFailure, statusState.statusContext, attempt, {
      errorPhase: "connect",
    });
  }
  return offPeak?.kind === "queued";
}
