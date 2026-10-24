import { type ToolPart } from "@zcode/contracts";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface SubagentCandidate {
  agentId?: string;
  childSessionId: string;
  runInBackground: boolean;
  output: Record<string, unknown> | null;
  part: ToolPart;
  subagentType: string;
  summary?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  title: string;
}

export interface SubagentEventRelation {
  agentId?: string;
  childSessionId?: string;
  description?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  subagentType?: string;
  summary?: string;
}
