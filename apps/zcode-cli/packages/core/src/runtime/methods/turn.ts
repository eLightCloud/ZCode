import { captureHighspeedFallbackSelection } from "./turn-model.js";
import { getCurrentModelInvocationContext } from "@zcode/contracts";
import { runWithModelInvocationContext } from "@zcode/contracts";
import type { QueryId } from "../deps.js";
import type { TurnState } from "../deps.js";
import type { ExecuteTurnOptions } from "../types.js";
import type { TurnResult } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { isAutomationMutationRestrictedTurn } from "./turn-loop-state.js";
import { executeAdmittedTurnCommand } from "./turn-admitted-command.js";
import { acceptSubmissionModelSelection } from "./turn-model.js";

const MODEL_CREATION_FAILED_MESSAGE = "Model creation failed";
const MODEL_CREATION_TURN_PHASE = "model_creation";
const TURN_EXECUTION_FAILED_MESSAGE = "Turn execution failed";

export async function executeTurn(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
): Promise<TurnResult> {
  if (options?.modelExecution) {
    options = {
      ...options,
      modelExecution: captureHighspeedFallbackSelection(this, options.modelExecution),
    };
  }
  // 子调用入队后可能换异步执行栈，先冻结来源，不能在 drain 时丢失自动化限制。
  if (getCurrentModelInvocationContext()?.modelRequestPurpose === "automation") {
    options = { ...options, modelRequestPurpose: "automation" };
  }
  return await enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    onCommandAccepted: () => {
      // 原始 executeTurn 与协议 admission 共用接纳语义；Loop 开始后不再倒写旧选择。
      void acceptSubmissionModelSelection(
        this,
        options?.intent,
        options?.traceContext ?? this.rootTraceContext,
        options?.modelExecution,
      ).catch((error) => {
        this.logger?.warn("Accepted model selection projection failed", { error: String(error) });
      });
    },
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options,
      priority: "next",
      reject,
      resolve,
      traceContext: options?.traceContext ?? this.rootTraceContext,
    }),
  });
}

export async function executeTurnCommand(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
  startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  const inherited = getCurrentModelInvocationContext();
  const trace = options?.traceContext ?? this.rootTraceContext;
  const automatic =
    isAutomationMutationRestrictedTurn({
      automationId: options?.automationId,
      toolDisallowlist: options?.toolDisallowlist,
      turnTraceContext: {
        ...trace,
        queryId: options?.queryId ?? (options?.inputId as QueryId | undefined) ?? trace.queryId,
      },
    }) ||
    ((options?.inputSource === "background_task" || options?.inputSource === "subagent_message") &&
      isAutomationMutationRestrictedTurn({ turnTraceContext: trace }));
  return runWithModelInvocationContext(
    {
      ...inherited,
      ...(this.modelRequestPurpose || automatic || options?.modelRequestPurpose
        ? { modelRequestPurpose: "automation" as const }
        : {}),
    },
    () => executeAdmittedTurnCommand.call(this, input, attachments, options, startReservation),
  );
}
