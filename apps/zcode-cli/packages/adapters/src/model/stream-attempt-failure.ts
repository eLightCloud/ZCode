import type { ModelRetryBudget } from "@zcode/contracts";
import type { StreamReplayState } from "./stream-attempt-contract.js";
import { ModelFailureReason as ModelFailureReasonValue } from "@zcode/contracts";
import { ModelRetryReason } from "@zcode/contracts";
import { classifyModelFailure } from "./failure-classifier.js";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { getResponseHeaders } from "./failure-inspection.js";
import { unwrapRetryError } from "./failure-inspection.js";
import { offPeakTicketExpiredMessage } from "./offpeak-retry.js";
import { resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { StreamDiagnostics } from "./runner-diagnostics.js";
import { logStreamFailureDiagnostics } from "./runner-diagnostics.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import type { AttemptAdmission } from "./request-admission.js";
import { publishModelStatus } from "./runner-status.js";
import { AccountRequestRetry } from "./account-request-retry.js";
import { RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";
import { readModelFailureErrorPhase } from "./runner-telemetry.js";
import type { RunStreamTextInput } from "./stream-attempt-contract.js";
import type { StreamDeliveryState } from "./stream-attempt-contract.js";
import type { StreamIteratorState } from "./stream-attempt-contract.js";
import type { StreamMetricState } from "./stream-attempt-contract.js";
import type { StreamRequestState } from "./stream-attempt-contract.js";
import type { StreamStatusState } from "./stream-attempt-contract.js";
import { resolveStreamFailureDecision } from "./stream-failure-policy.js";
import { statusPublishOptions } from "./stream-status.js";
import { AiSdkModelAdapterError } from "./errors.js";

export async function resolveStreamAttemptFailure(
  deliveryState: StreamDeliveryState,
  repairThinkingSignatureRejection: (error: unknown) => boolean,
  error: unknown,
  statusState: StreamStatusState,
  statusMaxAttempts: (extraAttempts: number) => number,
  authRetry: AccountRequestRetry,
  input: RunStreamTextInput,
  requestState: StreamRequestState,
  iteratorState: StreamIteratorState,
  retryBudgetAttempt: number,
  retryBudget: ModelRetryBudget | undefined,
  diagnostics: StreamDiagnostics,
  metricState: StreamMetricState,
  replayState: StreamReplayState,
  attempt: number,
  startedAt: number,
  admission: AttemptAdmission,
) {
  const completedAt = Date.now();
  const retryWithRepairedHistory =
    !deliveryState.emittedRetryBoundaryEvent && repairThinkingSignatureRejection(error);
  if (retryWithRepairedHistory) {
    statusState.statusContext = {
      ...statusState.statusContext,
      maxAttempts: statusMaxAttempts(1 + authRetry.extraAttempts),
    };
  }
  const classified = classifyModelFailure(error, input.request.abortSignal);
  if (error instanceof RuntimeHeadersRefreshError) {
    classified.message = error.message;
    classified.retryable = false;
  }
  // off-peak 特判（仅 idle plan provider）：排队 429 豁免预算无限探测；3102 标记落败触发续跑。
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: requestState.resolved.accountAccess?.mode === "off-peak",
    failure: classified,
    error: unwrapRetryError(error),
  });
  const failure: ClassifiedModelFailure =
    offPeak?.kind === "ticketExpired"
      ? {
          ...classified,
          retryable: false,
          message: offPeakTicketExpiredMessage(classified.message),
        }
      : offPeak?.kind === "queued"
        ? {
            ...classified,
            retryable: true,
            retryReason: ModelRetryReason.OffpeakQueued,
          }
        : classified;
  const errorPhase =
    readModelFailureErrorPhase(error) ??
    (iteratorState.streamIterator === undefined ? "prepare" : "stream");
  iteratorState.awaitIteratorClose = failure.reason !== ModelFailureReasonValue.Cancelled;
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  const failureDecision = resolveStreamFailureDecision({
    attempt: retryBudgetAttempt,
    emittedRetryBoundaryEvent: deliveryState.emittedRetryBoundaryEvent,
    error,
    failure,
    maxAttempts: input.retry.maxAttempts,
    preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
    responseHeaders,
    retryBudget,
    streamIteratorCreated: iteratorState.streamIterator !== undefined,
    streamErrorChunkObserved: Boolean(diagnostics.lastErrorChunk || diagnostics.lastFinishChunk),
  });
  const retryWithAuth = authRetry.claim(
    error,
    requestState.options === undefined ||
      deliveryState.emittedRetryBoundaryEvent ||
      metricState.streamOutputCommitted ||
      (input.request.preserveProviderStreamBoundaries === true &&
        failureDecision.context?.streamFailurePhase === "response_body"),
  );
  if (retryWithAuth) {
    failureDecision.canRetry = true;
    statusState.statusContext = {
      ...statusState.statusContext,
      maxAttempts: statusMaxAttempts(
        Number(replayState.signatureRepairAttempted) + authRetry.extraAttempts,
      ),
    };
  }
  // off-peak 排队 429 豁免预算：不消耗 maxAttempts，SSE 可见输出边界仍适用。
  if (offPeak?.kind === "queued" && !deliveryState.emittedRetryBoundaryEvent) {
    failureDecision.canRetry = true;
  }
  if (retryWithRepairedHistory) {
    failureDecision.canRetry = true;
  }

  logStreamFailureDiagnostics({
    attempt,
    canRetry: failureDecision.canRetry,
    diagnostics,
    durationMs: completedAt - startedAt,
    emittedError: deliveryState.emittedError,
    emittedEvent: deliveryState.emittedEvent,
    emittedRetryBoundaryEvent: deliveryState.emittedRetryBoundaryEvent,
    error,
    failure,
    logger: input.logger,
    statusContext: statusState.statusContext,
  });
  await publishModelStatus(
    {
      ...statusState.statusContext,
      attempt,
      durationMs: completedAt - startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: requestState.requestHeaderCount,
      requestHeaders: requestState.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: failureDecision.canRetry,
      statusCode: failure.statusCode,
      streamOutputCommitted: metricState.streamOutputCommitted,
      ...modelFailureStatusFields(error, failure, errorPhase),
      timestamp: new Date(completedAt).toISOString(),
      type: "model_request_failed",
      ...(error instanceof AiSdkModelAdapterError && error.usage ? { usage: error.usage } : {}),
    },
    {
      ...statusPublishOptions(input, admission),
      failureError: unwrapRetryError(error),
    },
  );
  iteratorState.terminalStatusPublished = true;
  return {
    retryWithAuth,
    failure,
    responseHeaders,
    retryWithRepairedHistory,
    failureDecision,
    errorPhase,
    offPeak,
  };
}
