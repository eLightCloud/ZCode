import { HookEventName } from "../deps.js";

import type { Model, TraceContext } from "../deps.js";

import { throwIfTurnAborted } from "../helpers/index.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { rebuildContextPrefix } from "./context-refresh.js";

export async function prepareRegularTurnContext(
  this: AgentRuntimeInternal,
  admittedModel: Model | undefined,
  turnTraceContext: TraceContext,
  completeTurnPhase: (phase: string, startedAt: number) => void,
  phaseStartedAt: number,
  turnAbortSignal: AbortSignal,
  startTurnPhase: (phase: string) => number,
) {
  if (this.contextInitialized) {
    // 每个后续 model step 都按该步骤实际持有的 Model 重新投影 Context；
    // Session Selection 只决定未来创建哪个 Model，不能充当执行事实。
    rebuildContextPrefix(this, { model: admittedModel });
  } else {
    // 首轮初始化已经用 admitted Model 构造并安装完整 Context，随后再 rebuild
    // 会把同一 Prefix 连续构造两次。未初始化与已初始化分支互斥，每个 model step 只构造一次。
    await this.ensureContextInitialized(turnTraceContext, admittedModel);
  }
  completeTurnPhase("context_initialization", phaseStartedAt);
  throwIfTurnAborted(turnAbortSignal);
  phaseStartedAt = startTurnPhase("session_start_hooks");
  const sessionStartHookResult = await this.runSessionStartHooks(
    "startup",
    turnTraceContext,
    turnAbortSignal,
    admittedModel,
  );
  completeTurnPhase("session_start_hooks", phaseStartedAt);
  this.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.SessionStart,
    sessionStartHookResult.additionalContexts,
  );
  return phaseStartedAt;
}
