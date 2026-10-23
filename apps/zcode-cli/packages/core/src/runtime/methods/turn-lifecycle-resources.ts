import type { TraceContext, TurnId } from "../deps.js";
import { createTurnAbortScope } from "../helpers/index.js";

import type { ActiveTurnSteeringState } from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { disposeProjectMemoryRecallPrefetch } from "../helpers/project-memory-recall.js";

import { clearBrowserTurnState } from "../../repl/browser-turn-state.js";

export async function releaseRegularTurnResources(
  this: AgentRuntimeInternal,
  targetRunHeartbeat: ReturnType<typeof setInterval> | undefined,
  turnId: TurnId,
  activeTurn: ActiveTurnSteeringState | undefined,
  turnAbortScope: ReturnType<typeof createTurnAbortScope>,
  turnTraceContext: TraceContext,
) {
  disposeProjectMemoryRecallPrefetch(this);
  if (targetRunHeartbeat) {
    clearInterval(targetRunHeartbeat);
  }
  this.releaseTurnStart(turnId);
  clearBrowserTurnState(this.sessionId, turnId);
  this.finishActiveTurn(activeTurn);
  turnAbortScope.dispose();
  try {
    await this.browserControlPort?.turnEnded?.({
      sessionId: this.sessionId,
      turnId: String(turnId),
      traceContext: turnTraceContext,
    });
  } catch (error) {
    // 生命周期清理失败不能覆盖已经完成/失败的主 turn；backend 会在 session close 再兜底释放。
    this.logger?.warn("Browser turn cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "browser.turn_cleanup.failed",
      turnId: String(turnId),
    });
  }
}
