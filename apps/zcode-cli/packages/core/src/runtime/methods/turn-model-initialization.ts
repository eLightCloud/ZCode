import type { SessionEvent, TraceContext } from "../deps.js";

import { appendTurnOutcomeEvent, createTurnFailureError } from "../helpers/index.js";

import type { ExecuteTurnOptions, ParsedRewindCommand } from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { createTurnModel, resolveExecutionModelRetryBudget } from "./turn-model.js";

export async function createAdmittedTurnModel(
  this: AgentRuntimeInternal,
  rewindCommand: ParsedRewindCommand | null,
  options: ExecuteTurnOptions | undefined,
  admittedModelSelection:
    | {
        providerId: string;
        modelId: string;
        options?: { reasoningLevel?: string | undefined } | undefined;
      }
    | undefined,
  failureState: { turnFailureHandled: boolean },
  turnAbortSignal: AbortSignal,
  events: SessionEvent[],
  turnStartedAtMs: number,
  turnTraceContext: TraceContext,
) {
  let admittedModel;
  try {
    admittedModel =
      rewindCommand === null
        ? createTurnModel(this, {
            requestDependencies: options?.modelExecution?.requestDependencies,
            selection: admittedModelSelection,
            // 带退回声明的执行句柄 0 次重试：失败立刻交给 turn step 退回会话模型。
            retryBudget: resolveExecutionModelRetryBudget({
              selection: admittedModelSelection,
              selectionFallback: options?.modelExecution?.selectionFallback,
            }),
          })
        : undefined;
  } catch (error) {
    // 同步滞后/模型失效可在内层 Turn try 之前创建失败。只写日志会让已接纳输入
    // 没有终态、桌面与手机都看不到错误；复用 outcome，不等待同步、不改原选择。
    failureState.turnFailureHandled = true;
    const coreError = createTurnFailureError(error, turnAbortSignal, "Model creation failed");
    await appendTurnOutcomeEvent(this, {
      coreError,
      events,
      durationMs: Date.now() - turnStartedAtMs,
      turnPhase: "model_creation",
      inputId: options?.inputId,
      traceContext: turnTraceContext,
      fallbackMessage: "Model creation failed",
      logEvent: "turn.failed",
      logLabel: "Turn",
    });
    throw coreError;
  }
  return admittedModel;
}
