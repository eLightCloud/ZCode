import type { AiSdkModelTextRequest, AiSdkStreamTextResult } from "./runner-runtime.js";

import { logStreamDiagnostics } from "./runner-diagnostics.js";
import type { StreamDiagnostics } from "./stream-diagnostics-contract.js";

import { recordStreamTextDebug } from "./runner-debug.js";

import { type AttemptAdmission } from "./request-admission.js";

import { publishModelStatus } from "./runner-status.js";

import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";

import { providerRequestIdFromHeaders } from "./runner-telemetry.js";

import type {
  RunStreamTextInput,
  StreamDeliveryState,
  StreamIteratorState,
  StreamMetricState,
  StreamRequestState,
  StreamStatusState,
} from "./stream-attempt-contract.js";

import { resolveStreamResponseHeaders } from "./stream-response-headers.js";

import { statusPublishOptions } from "./stream-status.js";

export async function completeStreamAttempt(
  attempt: number,
  diagnostics: StreamDiagnostics,
  startedAt: number,
  deliveryState: StreamDeliveryState,
  input: RunStreamTextInput,
  requestState: StreamRequestState,
  statusState: StreamStatusState,
  streamResult: AiSdkStreamTextResult,
  metricState: StreamMetricState,
  admission: AttemptAdmission,
  iteratorState: StreamIteratorState,
  recordModelIO: boolean,
  isDev: boolean,
  toolCallAssembler: StreamingToolCallAssembler,
  attemptRequest: AiSdkModelTextRequest,
) {
  logStreamDiagnostics({
    attempt,
    diagnostics,
    durationMs: Date.now() - startedAt,
    emittedError: deliveryState.emittedError,
    emittedEvent: deliveryState.emittedEvent,
    logger: input.logger,
    outboundHeaders: requestState.resolved.headers,
    statusContext: statusState.statusContext,
  });
  if (!deliveryState.emittedError) {
    const completedAt = Date.now();
    const responseHeaders = await resolveStreamResponseHeaders(streamResult);
    await publishModelStatus(
      {
        ...statusState.statusContext,
        attempt,
        durationMs: completedAt - startedAt,
        requestHeaderCount: requestState.requestHeaderCount,
        requestHeaders: requestState.requestHeaders,
        responseHeaderCount: Object.keys(responseHeaders).length,
        responseHeaders,
        providerRequestId: providerRequestIdFromHeaders(responseHeaders),
        finishReason: diagnostics.finishReason,
        usage: diagnostics.usage,
        timeToFirstProviderEventMs: metricState.timeToFirstProviderEventMs,
        timeToFirstContentMs: metricState.timeToFirstContentMs,
        timeToFirstTextMs: metricState.timeToFirstTextMs,
        streamMaxIdleMs: metricState.streamMaxIdleMs || undefined,
        streamStallCount: metricState.streamStallCount,
        streamOutputCommitted: metricState.streamOutputCommitted,
        timestamp: new Date(completedAt).toISOString(),
        type: "model_request_completed",
      },
      statusPublishOptions(input, admission),
    );
    iteratorState.terminalStatusPublished = true;
  }
  if (recordModelIO && requestState.options) {
    await recordStreamTextDebug({
      modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
      attempt,
      debugDir: input.debugDir,
      isDev,
      normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
      options: requestState.options,
      recordModelIO,
      request: attemptRequest,
      requestId: statusState.statusContext.requestId,
      resolved: requestState.resolved,
      result: streamResult,
      startedAt,
    });
  }
}
