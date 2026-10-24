import type { AiSdkModelTextRequest } from "./runner-runtime.js";
import type { TextStreamPart, ToolSet } from "ai";
import type { Logger, ModelStatusSink, ModelStreamEvent } from "@zcode/contracts";
import type { AttemptAdmission } from "./request-admission.js";
import type { TerminalStreamChunkError } from "./runner-retry.js";
import type { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import type { ResolvedAiSdkModel } from "./runner-runtime.js";
import type { StreamDiagnostics } from "./stream-diagnostics-contract.js";
import type { ModelStatusContext } from "./model-status-context.js";

// 两条处理分支共用的数据合同，不依赖任一处理器实现。
export interface StreamChunkInput {
  /** 本次尝试的准入：错误块的退避 sleep 之前先归还。 */
  admission: AttemptAdmission;
  attempt: number;
  chunk: TextStreamPart<ToolSet>;
  diagnostics: StreamDiagnostics;
  emittedRetryBoundaryEvent: boolean;
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    resolved: ResolvedAiSdkModel;
    retry: ResolvedAiSdkModelRetryOptions;
    statusSink?: ModelStatusSink;
  };
  pendingRetrySafeEvents: ModelStreamEvent[];
  repairThinkingSignatureRejection: (error: unknown) => boolean;
  canRecoverProjectToken: (error: unknown) => boolean;
  retryBudgetAttempt: number;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  startedAt: number;
  statusContext: ModelStatusContext;
  toolCallAssembler: StreamingToolCallAssembler;
}

export interface StreamChunkResult {
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  retryScheduled: boolean;
  /** off-peak 排队重试：外层 for 冻结 attempt 预算。 */
  offPeakQueueHold: boolean;
  terminalError?: TerminalStreamChunkError;
  visibleEvents: ModelStreamEvent[];
}
