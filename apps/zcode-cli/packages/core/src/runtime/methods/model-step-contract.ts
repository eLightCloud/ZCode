import type { ToolSearchExecutionContext } from "@zcode/contracts";
import type { DrainedPendingInputDiagnostics } from "../types.js";
import type { RunModelTextRequestOptions } from "../model-execution-types.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ModelToolContract } from "../deps.js";
export type ModelStepResult = "continue" | "output_continuation" | "break";

export type ModelStepRequestOptions = {
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  latestRealUserMessageIndex?: number;
  messages: RunModelTextRequestOptions["messages"];
  sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
  recordedMessages: RunModelTextRequestOptions["messages"];
  requestEntries: readonly RuntimeMessageEntry[];
  tools: ModelToolContract[];
  toolSearch?: ToolSearchExecutionContext;
};
