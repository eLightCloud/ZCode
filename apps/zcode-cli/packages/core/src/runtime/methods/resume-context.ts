import { formatGoalStateForModel, traceContextToLogContext } from "../deps.js";

import type { SessionGoal, TodoItem, TraceContext } from "../deps.js";

import type { AgentRuntimeInternal } from "../internal.js";

export async function readSessionTodosForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<TodoItem[]> {
  if (!this.sessionStore) {
    return [];
  }

  try {
    return await this.sessionStore.readTodos({ sessionID: this.sessionId });
  } catch (error) {
    // Todo state is continuity context. If the store cannot read it, resume/compact can still
    // proceed from transcript history while surfacing the degradation in structured logs.
    this.logger?.warn("Failed to read session todos for context", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "todo.context.read.failed",
      module: "core.runtime",
      status: "failed",
    });
    return [];
  }
}

export async function readSessionTargetForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (!this.sessionStore) {
    return null;
  }

  try {
    return await this.sessionStore.readTarget({ sessionID: this.sessionId });
  } catch (error) {
    // Goal state is continuity context. Resume should still work from transcript history
    // if goal storage is temporarily unavailable.
    this.logger?.warn("Failed to read session goal for context", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.context.read.failed",
      module: "core.runtime",
      status: "failed",
    });
    return null;
  }
}

export function injectTargetStateIntoMessageHistory(
  this: AgentRuntimeInternal,
  target: SessionGoal | null,
): void {
  const targetState = formatGoalStateForModel(target);
  if (!targetState) {
    return;
  }

  this.messageHistory.addAttachment(
    "resume_goal_state",
    [
      "The current session goal state was restored from session storage.",
      targetState,
      "Use it as the authoritative long-running objective unless a later GoalRead result or runtime goal event updates it.",
      "Do not mark the goal complete unless real evidence shows the objective has been achieved.",
      "A completed plan, todo list, checklist, or planning phase is not completion evidence unless the objective was only to produce that artifact.",
    ].join("\n"),
  );
}
