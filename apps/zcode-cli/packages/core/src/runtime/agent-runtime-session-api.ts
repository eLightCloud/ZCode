import type {
  CollaborationMode,
  ExecutionShellSelection,
  MessageId,
  ModelSelection,
  ProjectId,
  TraceContext,
  TurnInputIntentMetadata,
} from "./deps.js";

import type { AgentRuntimeConfig } from "./types.js";

export interface AgentRuntimeSessionApi {
  lastPermissionGrantId?: string;

  beginShutdown(): void;

  closeBrowserSession(): Promise<void>;

  updateConfig(
    patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
  ): void;

  initializeSessionShellEnvironmentIfNeeded(
    selection: ExecutionShellSelection | (() => ExecutionShellSelection),
  ): boolean;

  getSessionShellSelection(): ExecutionShellSelection | undefined;

  getMode(): CollaborationMode;

  getPlanEnabled(): boolean;

  grantPermissionFullAccess(interactionId: string, signal?: AbortSignal): Promise<string>;

  setExecutionState(
    input: { mode?: string; planEnabled?: boolean },
    traceContext?: TraceContext,
  ): Promise<void>;

  getSessionModelSelection(): ModelSelection | undefined;

  setSessionModelSelection(selection: ModelSelection | undefined): void;

  getProjectId(): ProjectId;

  ensureSessionPersistedForExternalActivity(
    input: string,
    options?: { traceContext?: TraceContext },
  ): Promise<void>;

  maybeStartSessionTitleGenerationFromExternalInput(
    input: string,
    options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
  ): void;

  /** renameSession：用户显式重命名（titleSource=custom，发 SessionTitleUpdated）。 */
  setCustomSessionTitle(input: { title: string; traceContext: TraceContext }): Promise<void>;

  maybeStartGoalSummaryTitleGeneration(
    input: string,
    targetID: string,
    options?: { traceContext?: TraceContext },
  ): boolean;

  recordExternalUserPrompt(
    input: string,
    options?: {
      goalSummaryTargetID?: string;
      traceContext?: TraceContext;
      intent?: TurnInputIntentMetadata;
    },
  ): Promise<MessageId>;

  recordPendingModelChange(input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  }): void;
}
