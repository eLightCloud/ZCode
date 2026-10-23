import { publishModelTelemetryMilestone } from "./runner-status.js";

import { AccountRequestRetry } from "./account-request-retry.js";

import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";

import type {
  RunStreamTextInput,
  StreamMetricState,
  StreamReplayState,
  StreamRequestState,
  StreamStatusState,
} from "./stream-attempt-contract.js";

export function createStreamAttemptObservers(
  replayState: StreamReplayState,
  requestState: StreamRequestState,
  input: RunStreamTextInput,
  attempt: number,
  authRetry: AccountRequestRetry,
  statusState: StreamStatusState,
  metricState: StreamMetricState,
  startedAt: number,
) {
  const repairThinkingSignatureRejection = (error: unknown): boolean => {
    if (
      replayState.signatureRepairAttempted ||
      requestState.resolved.providerKind !== "anthropic"
    ) {
      return false;
    }
    const repairedMessages = repairReasoningHistoryAfterSignatureRejection(
      replayState.requestMessages,
      error,
    );
    if (!repairedMessages) return false;

    // 签名只对生成它的 thinking block 有效。流尚未提交输出时，只替换
    // 本次请求副本，并给一次不占普通 retry 预算且拥有新 requestId 的物理请求机会；
    // 不能把清理结果写回 canonical history。
    replayState.signatureRepairAttempted = true;
    replayState.requestMessages = repairedMessages;
    input.logger?.warn("Retrying model stream after thinking signature rejection", {
      attempt,
      event: "model.reasoning_signature_repair.retry",
      maxAttempts: input.retry.maxAttempts + 1 + authRetry.extraAttempts,
      nextAttempt: attempt + 1,
      requestId: statusState.statusContext.requestId,
      status: "waiting",
    });
    return true;
  };
  const publishVisibleMilestones = async (observation: {
    contentMs?: number;
    textMs?: number;
  }): Promise<void> => {
    if (metricState.timeToFirstContentMs === undefined && observation.contentMs !== undefined) {
      metricState.timeToFirstContentMs = observation.contentMs;
      await publishModelTelemetryMilestone(
        {
          ...statusState.statusContext,
          attempt,
          elapsedMs: observation.contentMs,
          timestamp: new Date(startedAt + observation.contentMs).toISOString(),
          type: "model_first_content",
        },
        { logger: input.logger, statusSink: input.statusSink },
      );
    }
    if (metricState.timeToFirstTextMs === undefined && observation.textMs !== undefined) {
      metricState.timeToFirstTextMs = observation.textMs;
      await publishModelTelemetryMilestone(
        {
          ...statusState.statusContext,
          attempt,
          elapsedMs: observation.textMs,
          timestamp: new Date(startedAt + observation.textMs).toISOString(),
          type: "model_first_text",
        },
        { logger: input.logger, statusSink: input.statusSink },
      );
    }
  };
  return { repairThinkingSignatureRejection, publishVisibleMilestones };
}
