import { classifyModelFailure } from "./failure-classifier.js";

import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";

import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";

import { toAdapterError } from "./runner-retry.js";

import { publishModelStatus } from "./runner-status.js";
import type { ModelStatusContext } from "./model-status-context.js";

import { modelFailureStatusFields } from "./runner-telemetry.js";

import type { RunGenerateTextInput } from "./generate-contract.js";

import { statusPublishOptions } from "./generate-status.js";

export async function failGenerateBackoff(
  sleepError: unknown,
  input: RunGenerateTextInput,
  statusContext: ModelStatusContext,
  attempt: number,
  requestHeaderCount: number,
  requestHeaders: Record<string, string>,
) {
  const sleepFailure = classifyModelFailure(sleepError, input.request.abortSignal);
  const sleepResponseHeaders = sanitizeModelNetworkHeaders(
    getResponseHeaders(unwrapRetryError(sleepError)),
  );
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      message: sleepFailure.message,
      reason: sleepFailure.reason,
      requestHeaderCount,
      requestHeaders,
      responseHeaderCount: Object.keys(sleepResponseHeaders).length,
      responseHeaders: sleepResponseHeaders,
      retryable: false,
      statusCode: sleepFailure.statusCode,
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
  throw toAdapterError(sleepError, sleepFailure, statusContext, attempt, {
    errorPhase: "connect",
  });
}
