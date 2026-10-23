import type { Model, TraceContext, TurnId, TurnState } from "./deps.js";

import type {
  ActiveTurnStartReservation,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  TurnResult,
} from "./types.js";

export interface InternalTurnAdmissionMethods {
  admitPrompt(
    input: string,
    attachments?: TurnState["attachments"],
    options?: PromptAdmissionOptions,
  ): Promise<PromptAdmissionReceipt>;

  executeTurn(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
  ): Promise<TurnResult>;

  executeTurnCommand(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
    startReservation?: ActiveTurnStartReservation,
  ): Promise<TurnResult>;

  executeManualCompact(
    input: string,
    customInstructions: string | undefined,
    turnId: TurnId,
    turnTraceContext: TraceContext,
    abortSignal?: AbortSignal,
    inputId?: string,
    model?: Model,
  ): Promise<TurnResult>;
}
