import { classifyModelFailure } from "./failure-classifier.js";

import { unwrapRetryError } from "./failure-inspection.js";

import { toAdapterError } from "./runner-retry.js";

import { publishModelStatus } from "./runner-status.js";
import type { ModelStatusContext } from "./model-status-context.js";

import { modelFailureStatusFields } from "./runner-telemetry.js";

import type { RunGenerateTextInput } from "./generate-contract.js";

import { statusPublishOptions } from "./generate-status.js";

export async function failGenerateAdmission(
  admitError: unknown,
  input: RunGenerateTextInput,
  statusContext: ModelStatusContext,
  attempt: number,
  requestHeaderCount: number,
  requestHeaders: Record<string, string>,
): Promise<never> {
  const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      message: admitFailure.message,
      reason: admitFailure.reason,
      requestHeaderCount,
      requestHeaders,
      retryable: false,
      statusCode: admitFailure.statusCode,
      ...modelFailureStatusFields(admitError, admitFailure, "connect"),
      timestamp: new Date().toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input),
      failureError: unwrapRetryError(admitError),
    },
  );
  throw toAdapterError(admitError, admitFailure, statusContext, attempt, {
    errorPhase: "connect",
  });
}
