import type { CreateSessionInput, ForkCommandResult } from "./session-metadata.js";
import type { SessionId } from "./shared.js";
import type { GoalStatus, SessionGoal } from "../tools/target.js";
import type { MessageWithParts } from "./session-message.js";
import type { SessionEntryInfo, SessionInputDelivery } from "./session-entries.js";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/**
 * conversation fork 的唯一原子提交载荷。core 在内存完成 remap；adapter 不参与业务裁决，
 * 只保证 child/copy/goal/entries/input/parent command fact 全有或全无。
 */
export interface ForkCommitBundle {
  child: CreateSessionInput;
  messages: MessageWithParts[];
  entries: SessionEntryInfo[];
  /** 存储复制来源（目标 ID -> 父记录 ID）；只保留旧磁盘快照，不参与模型选择。 */
  copySources?: { messages: Record<string, string>; parts: Record<string, string> };
  goal?: { source: SessionGoal; status: GoalStatus };
  initialInput?: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  };
  commandFact: {
    parentSessionId: string;
    sourceCommandId: string;
    ack: {
      commandId: string;
      status: "accepted";
      revisionAtDecision: number;
      result: ForkCommandResult;
    };
    metadata: Record<string, unknown>;
  };
}
