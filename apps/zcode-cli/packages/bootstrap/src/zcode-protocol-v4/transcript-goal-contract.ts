// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/** goal verify 事实的归一形态：timeline part（新契约）与 session_entry（legacy 主体）共用。 */
export interface GoalVerificationFact {
  key: string;
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  anchorAssistantMessageId?: string;
  anchorTurnId?: string;
  status?: string;
  verification?: unknown;
}

// ── session_entry legacy 源──
// 历史上 goal verify 主要持久化在 session_entry（本机观测 1,402 行 vs timeline part
// 仅 10 行）；entry.data 保留了原始事件 payload。读取端跨源按 targetId_goalIteration
// 去重：timeline part 与 entry 表达同一事实时只发一次（先到先得，anchor 语义一致）。
export interface HydratedGoalVerificationEntry {
  payload: {
    targetId: string;
    status?: string;
    verificationId: string;
    verification?: unknown;
    goalIteration?: number;
    anchorAssistantMessageId?: string;
    anchorTurnId?: string;
  };
  sequenceNumber?: number;
  timeCreated: number;
}
