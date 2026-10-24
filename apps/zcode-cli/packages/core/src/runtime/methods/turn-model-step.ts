import type { ModelStepRequestOptions } from "./model-step-contract.js";
import { createMessageId } from "../deps.js";
import type { ModelToolContract } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { isTurnCancellationError } from "../helpers/index.js";
import type { DrainedPendingInputDiagnostics } from "../types.js";
import type { RunModelTextRequestOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import type { ModelStepResult } from "./model-step-contract.js";
import { runModelBackedTurnStepImpl } from "./model-step-execution.js";
import type { ToolSearchExecutionContext } from "@zcode/contracts";

export async function runModelBackedTurnStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: ModelStepRequestOptions,
): Promise<ModelStepResult> {
  const assistantMessageId = createMessageId();
  const stepTelemetry = this.agentTelemetry.step({
    stepId: assistantMessageId,
    stepIndex: state.modelStepCount,
  });
  return stepTelemetry.run(async () => {
    try {
      const result = await runModelBackedTurnStepImpl.call(
        this,
        state,
        options,
        assistantMessageId,
      );
      stepTelemetry.finishCompleted(
        result === "output_continuation"
          ? "model_completed"
          : result === "continue"
            ? "tool_requested"
            : "turn_completed",
      );
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, state.turnAbortSignal)) {
        stepTelemetry.finishCancelled("abort_signal");
      } else {
        stepTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}
