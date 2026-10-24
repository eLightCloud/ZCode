import { CompactPhase } from "../deps.js";
import { CompactReason } from "../deps.js";
import { CompactTrigger } from "../deps.js";
import type { Model } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ModelToolContract } from "@zcode/contracts";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/** 同一 compact owner 的选项合同；各阶段只借用此投影。 */
export type CompactActiveOptions = {
  abortSignal?: AbortSignal;
  compactContextTelemetry?: {
    inputTokens: number;
    policyContextWindowTokens: number;
    thresholdTokens?: number;
    tokenSource: "estimate" | "provider_usage";
  };
  autoCompactThreshold?: number;
  compactReason?: CompactReason;
  initialPromptTooLongCause?: unknown;
  phase?: CompactPhase;
  sourceCommandId?: string;
  trigger?: CompactTrigger;
  model?: Model;
  agentListingTools?: readonly { name: string }[];
  activeEntries?: readonly RuntimeMessageEntry[];
  getContinuationTools?: () => readonly ModelToolContract[];
};
