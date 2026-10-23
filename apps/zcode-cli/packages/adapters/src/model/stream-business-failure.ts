import { classifyModelFailure } from "./failure-classifier.js";

import { StreamDiagnostics } from "./runner-diagnostics.js";

import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";

import { createRequestVerificationEmptyStreamError } from "./request-security-edition/recovery.js";

import { TerminalStreamChunkError, toAdapterError } from "./runner-retry.js";

import { isRequestVerificationRejection } from "./request-security-edition/recovery.js";

import type {
  RunStreamTextInput,
  StreamRequestState,
  StreamStatusState,
} from "./stream-attempt-contract.js";

import { compactStreamFailureContext } from "./stream-failure-policy.js";

export function rejectEmptyStreamBusinessFailure(
  statusState: StreamStatusState,
  diagnostics: StreamDiagnostics,
  requestState: StreamRequestState,
  input: RunStreamTextInput,
  attempt: number,
) {
  const streamEndedWithoutOutputError =
    detectProviderBusinessFinishError({
      providerId: String(statusState.statusContext.providerId),
      providerKind: statusState.statusContext.providerKind,
      source: diagnostics.lastErrorChunk ?? diagnostics.lastFinishChunk,
    }) ??
    createRequestVerificationEmptyStreamError({
      accountMode: requestState.resolved.accountAccess?.mode,
      headers: requestState.resolved.headers,
      providerId: String(statusState.statusContext.providerId),
      providerKind: requestState.resolved.providerKind,
    });
  if (streamEndedWithoutOutputError) {
    if (isRequestVerificationRejection(streamEndedWithoutOutputError))
      throw streamEndedWithoutOutputError;
    const failure = classifyModelFailure(streamEndedWithoutOutputError, input.request.abortSignal);
    throw new TerminalStreamChunkError(
      toAdapterError(streamEndedWithoutOutputError, failure, statusState.statusContext, attempt, {
        ...compactStreamFailureContext(
          input.request.preserveProviderStreamBoundaries,
          "response_body",
        ),
        errorPhase: "stream",
      }),
    );
  }
}

export function rejectStreamBusinessFailure(
  statusState: StreamStatusState,
  diagnostics: StreamDiagnostics,
  input: RunStreamTextInput,
  attempt: number,
) {
  const hiddenProviderBusinessError = detectProviderBusinessFinishError({
    providerId: String(statusState.statusContext.providerId),
    providerKind: statusState.statusContext.providerKind,
    source:
      diagnostics.lastFinishChunk ??
      ({
        type: "finish",
        finishReason: diagnostics.finishReason,
        rawFinishReason: diagnostics.rawFinishReason,
      } satisfies Record<string, unknown>),
  });
  if (hiddenProviderBusinessError) {
    if (isRequestVerificationRejection(hiddenProviderBusinessError))
      throw hiddenProviderBusinessError;
    const failure = classifyModelFailure(hiddenProviderBusinessError, input.request.abortSignal);
    throw new TerminalStreamChunkError(
      toAdapterError(hiddenProviderBusinessError, failure, statusState.statusContext, attempt, {
        ...compactStreamFailureContext(
          input.request.preserveProviderStreamBoundaries,
          "response_body",
        ),
        errorPhase: "stream",
      }),
    );
  }
}
