import type { AgentRuntimeConfig } from "../types.js";
import type { Model, ModelToolContract, TraceContext } from "../deps.js";
import type { AgentTelemetryCausation, ModelApiOperation } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ReadFileStateMap } from "../../tool/types.js";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface ProjectMemoryAgentContext {
  causation?: AgentTelemetryCausation;
  memoryRoot: string;
  providerEntries: readonly RuntimeMessageEntry[];
  midConversationSystem: AgentRuntimeConfig["midConversationSystem"];
  model: Model;
  operation: ModelApiOperation;
  readFileState: ReadFileStateMap;
  tools: readonly ModelToolContract[];
  traceContext: TraceContext;
  workingDirectory: string;
  workspaceRoot: string;
}
