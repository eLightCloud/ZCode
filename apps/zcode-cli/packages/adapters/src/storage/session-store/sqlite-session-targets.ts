import type { GoalStatus, SessionGoal, SessionId, TodoItem } from "@zcode/contracts";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。

import {
  accountSessionTargetUsage,
  clearSessionTarget,
  cloneSessionTargetForFork,
  createSessionTarget,
  finishSessionTargetRun,
  heartbeatSessionTargetRun,
  readSessionTarget,
  recoverInterruptedSessionTargetRun,
  setSessionTarget,
  startSessionTargetRun,
  updateSessionTargetStatus,
  updateSessionTargetSummaryTitle,
} from "../session-target.js";

import * as todoRepository from "./repositories/todos.js";

import type { SqliteSessionStoreContext } from "./sqlite-session-context.js";
export async function readTodos(
  this: SqliteSessionStoreContext,
  input: { sessionID: SessionId },
): Promise<TodoItem[]> {
  return todoRepository.readTodos(this.db, input);
}

export async function updateTodos(
  this: SqliteSessionStoreContext,
  input: { sessionID: SessionId; todos: TodoItem[] },
): Promise<void> {
  this.throwBeforeWrite();
  return todoRepository.updateTodos(this.db, input);
}

export async function readTarget(
  this: SqliteSessionStoreContext,
  input: { sessionID: SessionId },
): Promise<SessionGoal | null> {
  return readSessionTarget(this.db, input);
}

export async function setTarget(
  this: SqliteSessionStoreContext,
  input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  },
): Promise<SessionGoal> {
  return setSessionTarget(this.db, {
    objective: input.objective,
    sessionID: input.sessionID,
    status: input.status ?? "active",
    tokenBudget: input.tokenBudget,
  });
}

export async function cloneTargetForFork(
  this: SqliteSessionStoreContext,
  input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  },
): Promise<SessionGoal> {
  this.throwBeforeWrite();
  return cloneSessionTargetForFork(this.db, {
    source: input.source,
    sessionID: input.sessionID,
    status: input.status ?? input.source.status,
  });
}

export async function createTarget(
  this: SqliteSessionStoreContext,
  input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  },
): Promise<SessionGoal | null> {
  return createSessionTarget(this.db, input);
}

export async function updateTargetStatus(
  this: SqliteSessionStoreContext,
  input: {
    sessionID: SessionId;
    status: GoalStatus;
  },
): Promise<SessionGoal | null> {
  return updateSessionTargetStatus(this.db, input);
}

export async function startTargetRun(
  this: SqliteSessionStoreContext,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  },
): Promise<SessionGoal | null> {
  return startSessionTargetRun(this.db, input);
}

export async function heartbeatTargetRun(
  this: SqliteSessionStoreContext,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  },
): Promise<SessionGoal | null> {
  return heartbeatSessionTargetRun(this.db, input);
}

export async function finishTargetRun(
  this: SqliteSessionStoreContext,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  },
): Promise<SessionGoal | null> {
  return finishSessionTargetRun(this.db, input);
}

export async function recoverInterruptedTargetRun(
  this: SqliteSessionStoreContext,
  input: { sessionID: SessionId },
): Promise<SessionGoal | null> {
  return recoverInterruptedSessionTargetRun(this.db, input);
}

export async function accountTargetUsage(
  this: SqliteSessionStoreContext,
  input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  },
): Promise<SessionGoal | null> {
  return accountSessionTargetUsage(this.db, input);
}

export async function updateTargetSummaryTitle(
  this: SqliteSessionStoreContext,
  input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  },
): Promise<SessionGoal | null> {
  return updateSessionTargetSummaryTitle(this.db, input);
}

export async function clearTarget(
  this: SqliteSessionStoreContext,
  input: { sessionID: SessionId },
): Promise<boolean> {
  return clearSessionTarget(this.db, input);
}
