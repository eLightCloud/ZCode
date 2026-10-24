import type { AiSdkGenerateTextOptions } from "./runner-runtime.js";
import type { AiSdkModelTextRequest } from "./runner-runtime.js";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { unwrapRetryError } from "./failure-inspection.js";
import { recordGenerateTextDebug } from "./runner-debug.js";
import { ModelStatusContext } from "./runner-status.js";
import { publishModelStatus } from "./runner-status.js";
import type { ResolvedAiSdkModel } from "./runner-runtime.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";
import type { AttemptAdmission } from "./request-admission.js";
import type { RunGenerateTextInput } from "./generate-contract.js";
import { statusPublishOptions } from "./generate-status.js";
import { AiSdkModelAdapterError } from "./errors.js";

export async function publishGenerateAttemptFailure(
  options: AiSdkGenerateTextOptions | undefined,
  input: RunGenerateTextInput,
  attempt: number,
  error: unknown,
  isDev: boolean,
  recordModelIO: boolean,
  attemptRequest: AiSdkModelTextRequest,
  statusContext: ModelStatusContext,
  resolved: ResolvedAiSdkModel,
  startedAt: number,
  completedAt: number,
  failure: ClassifiedModelFailure,
  requestHeaderCount: number,
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string>,
  canRetry: boolean,
  admission: AttemptAdmission,
) {
  if (options) {
    recordGenerateTextDebug({
      modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
      attempt,
      debugDir: input.debugDir,
      error,
      isDev,
      normalizedToolCalls: undefined,
      options,
      recordModelIO,
      request: attemptRequest,
      requestId: statusContext.requestId,
      resolved,
      startedAt,
    });
  }
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      durationMs: completedAt - startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount,
      requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: canRetry,
      statusCode: failure.statusCode,
      ...modelFailureStatusFields(error, failure, options ? "response" : "prepare"),
      timestamp: new Date(completedAt).toISOString(),
      type: "model_request_failed",
      ...(error instanceof AiSdkModelAdapterError && error.usage ? { usage: error.usage } : {}),
    },
    {
      ...statusPublishOptions(input, admission),
      failureError: unwrapRetryError(error),
    },
  );
}
