import type { AiSdkModelTextRequest, AiSdkStreamTextResult } from "./runner-runtime.js";
import { createLinkedAbortController } from "./stream-idle-timeout.js";

import { classifyModelFailure } from "./failure-classifier.js";

import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";

import { unwrapRetryError } from "./failure-inspection.js";

import { createStreamTextOptions } from "./runner-options.js";

import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";

import { type AttemptAdmission } from "./request-admission.js";

import { toAdapterError } from "./runner-retry.js";

import { publishModelStatus } from "./runner-status.js";

import { AccountRequestRetry } from "./account-request-retry.js";

import { resolveModelForAttempt } from "./runner-runtime-headers.js";

import { modelFailureStatusFields } from "./runner-telemetry.js";

import type {
  RunStreamTextInput,
  StreamIteratorState,
  StreamMetricState,
  StreamRequestState,
  StreamStatusState,
} from "./stream-attempt-contract.js";

import { statusPublishOptions } from "./stream-status.js";

export async function startStreamAttempt(
  requestState: StreamRequestState,
  attempt: number,
  authRetry: AccountRequestRetry,
  attemptRequest: AiSdkModelTextRequest,
  input: RunStreamTextInput,
  statusState: StreamStatusState,
  recordModelIO: boolean,
  startedAt: number,
  admission: AttemptAdmission,
  iteratorState: StreamIteratorState,
): Promise<AiSdkStreamTextResult> {
  requestState.resolved = await resolveModelForAttempt({
    attempt,
    reason: authRetry.takeReason(),
    request: authRetry.prepareRequest(attemptRequest),
    resolveModel: input.resolveModel,
  });
  const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
    env: input.env,
    providerKind: requestState.resolved.providerKind,
    sessionId: statusState.statusContext.sessionId,
  });
  requestState.options = createStreamTextOptions({
    anthropicMetadataUserId,
    env: input.env,
    includeModelIO: recordModelIO,
    request: attemptRequest,
    resolved: requestState.resolved,
    statusContext: statusState.statusContext,
  });
  requestState.requestHeaders = sanitizeModelNetworkHeaders(requestState.options.headers);
  requestState.requestHeaderCount = Object.keys(requestState.requestHeaders).length;
  await publishModelStatus(
    {
      ...statusState.statusContext,
      attempt,
      requestHeaderCount: requestState.requestHeaderCount,
      requestHeaders: requestState.requestHeaders,
      timestamp: new Date(startedAt).toISOString(),
      type: "model_request_started",
    },
    statusPublishOptions(input, admission),
  );
  const streamResult = input.runtime.streamText(requestState.options);
  requestState.result = streamResult;
  iteratorState.streamIterator = streamResult.fullStream[Symbol.asyncIterator]();
  return streamResult;
}

export async function failStreamAdmission(
  attemptAbortController: ReturnType<typeof createLinkedAbortController>,
  admitError: unknown,
  input: RunStreamTextInput,
  statusState: StreamStatusState,
  attempt: number,
  startedAt: number,
  requestState: StreamRequestState,
  metricState: StreamMetricState,
): Promise<never> {
  attemptAbortController.cleanup();
  const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
  await publishModelStatus(
    {
      ...statusState.statusContext,
      attempt,
      durationMs: Date.now() - startedAt,
      message: admitFailure.message,
      reason: admitFailure.reason,
      requestHeaderCount: requestState.requestHeaderCount,
      requestHeaders: requestState.requestHeaders,
      retryable: false,
      statusCode: admitFailure.statusCode,
      streamOutputCommitted: metricState.streamOutputCommitted,
      ...modelFailureStatusFields(admitError, admitFailure, "connect"),
      timestamp: new Date().toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input),
      failureError: unwrapRetryError(admitError),
    },
  );
  throw toAdapterError(admitError, admitFailure, statusState.statusContext, attempt, {
    errorPhase: "connect",
  });
}
