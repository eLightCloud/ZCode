import { TurnMachineImpl } from "../deps.js";
import { createChildTraceContext } from "../deps.js";
import { createQueryId } from "../deps.js";
import { createTurnId } from "../deps.js";
import type { QueryId } from "../deps.js";
import type { SessionEvent } from "../deps.js";
import { createTurnAbortScope } from "../helpers/index.js";
import { parseCompactCommand } from "../helpers/index.js";
import { parseRewindCommand } from "../helpers/index.js";
import type { ExecuteTurnOptions } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { prepareOffPeakTurn } from "../off-peak/runtime.js";

export function beginRegularTurnScope(
  this: AgentRuntimeInternal,
  input: string,
  options: ExecuteTurnOptions | undefined,
  startReservation: ActiveTurnStartReservation | undefined,
): RegularTurnScope {
  const offPeakTurn = prepareOffPeakTurn(this, options);
  options = offPeakTurn.options;
  const admittedModelSelection =
    options?.intent?.modelSelection ??
    (options && "executionSelection" in options
      ? options.executionSelection
      : this.getSessionModelSelection());
  // 加速轮期间新输入可以更新 Session 续跑选择；卡过期必须回到本轮启动时的普通模型。
  const highspeedFallbackSelection = options?.modelExecution?.selectionFallback
    ? structuredClone(
        "highspeedFallbackSelection" in options.modelExecution
          ? options.modelExecution.highspeedFallbackSelection
          : this.getSessionModelSelection(),
      )
    : undefined;
  const admittedOutputStyle = this.config.outputStyle;
  const compactInstructions = parseCompactCommand(input);
  const rewindCommand = parseRewindCommand(input);
  const turnId = startReservation?.turnId ?? createTurnId();
  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const displayInput = options?.displayInput ?? input;
  const turnTraceContext =
    startReservation?.traceContext ??
    createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
      queryId,
      sessionId: this.sessionId,
      turnId,
      attributes: {
        turnNumber: this.turnNumber,
      },
    });
  const traceId = turnTraceContext.traceId;
  const turnStartedAtMs = Date.now();
  const targetRunInputID = options?.inputId ?? String(turnId);
  const events: SessionEvent[] = [];
  const machineState: { turnMachine: TurnMachineImpl } = {
    turnMachine: TurnMachineImpl.create(this.sessionId, this.turnNumber, input, traceId, turnId),
  };
  this.currentTurnFileChanges = new Map();
  if (!startReservation) this.reserveTurnStart(turnId, turnTraceContext, "regular");

  const turnAbortScope = createTurnAbortScope(options?.abortSignal);
  const turnAbortSignal = turnAbortScope.signal;

  return {
    options,
    offPeakTurn,
    highspeedFallbackSelection,
    admittedModelSelection,
    admittedOutputStyle,
    compactInstructions,
    rewindCommand,
    turnId,
    queryId,
    displayInput,
    turnTraceContext,
    traceId,
    turnStartedAtMs,
    targetRunInputID,
    events,
    machineState,
    turnAbortScope,
    turnAbortSignal,
  };
}

interface RegularTurnScope {
  options: ExecuteTurnOptions | undefined;
  offPeakTurn: ReturnType<typeof prepareOffPeakTurn>;
  highspeedFallbackSelection: ReturnType<AgentRuntimeInternal["getSessionModelSelection"]>;
  admittedModelSelection: ReturnType<AgentRuntimeInternal["getSessionModelSelection"]>;
  admittedOutputStyle: AgentRuntimeInternal["config"]["outputStyle"];
  compactInstructions: ReturnType<typeof parseCompactCommand>;
  rewindCommand: ReturnType<typeof parseRewindCommand>;
  turnId: ReturnType<typeof createTurnId>;
  queryId: ReturnType<typeof createQueryId>;
  displayInput: string;
  turnTraceContext: import("../deps.js").TraceContext;
  traceId: import("../deps.js").TraceContext["traceId"];
  turnStartedAtMs: number;
  targetRunInputID: string;
  events: SessionEvent[];
  machineState: { turnMachine: TurnMachineImpl };
  turnAbortScope: ReturnType<typeof createTurnAbortScope>;
  turnAbortSignal: AbortSignal;
}
