import { readUserModelSelection } from "./session-model-selection.js";
import type { SupportedLocale } from "@zcode/contracts";

import {
  SessionGoal,
  type GoalStatus,
  type TurnInputIntentMetadata,
  type UiThemePreference,
} from "@zcode/contracts";

import { loadSessionTranscriptFromStore } from "../session-transcript.js";

import type { ProviderRegistryModelSource } from "./provider-registry-source.js";

import {
  getRegistryBackedModel,
  listRegistryBackedModels,
  resolveRegistryThoughtLevel,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";

import { createSubagentObservation } from "./subagent-observation.js";

import type { ZCodeApp } from "./types.js";

import type { CreateSessionFacadeDeps, SessionFacade } from "./session-facade-contract.js";

import { formatLegacyRuntimeModelValue } from "./session-model-selection.js";

export function createSessionReadFacade(
  deps: CreateSessionFacadeDeps,
  sessionState: {
    closePromise: Promise<void> | undefined;
    currentLocale: SupportedLocale;
    appProvidedToolNames: string[];
  },
  currentRegistrySelection: () =>
    | { owned: false }
    | {
        owned: true;
        registry: ProviderRegistryModelSource;
        selection?: ResolvedRegistrySelection;
      },
  readTargetWithInterruptedRunRecovery: () => Promise<SessionGoal | null>,
  setTargetStatus: (
    action: "cleared" | "set" | "status_updated",
    input: {
      objective?: string;
      displayText?: string;
      status?: GoalStatus;
      tokenBudget?: number | null;
      intent?: TurnInputIntentMetadata;
    },
  ) => Promise<boolean | SessionGoal | null>,
) {
  return {
    getMode: () => deps.runtime.getMode(),
    getModel: () => formatLegacyRuntimeModelValue(readUserModelSelection(deps)),
    getLocale: () => sessionState.currentLocale,
    getTheme: () => deps.configResult.config.ui.theme as UiThemePreference,
    getDefaultThoughtLevel: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? resolveRegistryThoughtLevel(registryState.selection)
        : readUserModelSelection(deps)?.options?.reasoningLevel;
    },
    // 当前档位只读会话事实；缺失时不能借默认档位伪装成已完成选择。
    getThoughtLevel: () => readUserModelSelection(deps)?.options?.reasoningLevel,
    loadSessionTranscript: async () =>
      await loadSessionTranscriptFromStore({
        sessionId: deps.sessionId,
        sessionStore: deps.sessionStore,
      }),
    ...createSubagentObservation(deps),
    readTodos: async () => deps.sessionStore.readTodos({ sessionID: deps.sessionId }),
    readTarget: readTargetWithInterruptedRunRecovery,
    setCustomSessionTitle: async (input) =>
      deps.runtime.setCustomSessionTitle({
        title: input.title,
        traceContext: input.traceContext ?? deps.traceContext,
      }),
    setTarget: async (input) =>
      (await setTargetStatus("set", input)) as Awaited<ReturnType<ZCodeApp["setTarget"]>>,
    updateTargetStatus: async (status) =>
      (await setTargetStatus("status_updated", { status })) as Awaited<
        ReturnType<ZCodeApp["updateTargetStatus"]>
      >,
    clearTarget: async () => (await setTargetStatus("cleared", {})) as boolean,
    listModels: () => {
      return listRegistryBackedModels(deps.providerRegistry);
    },
    getCurrentModelOption: () => {
      const selection = readUserModelSelection(deps);
      return selection && getRegistryBackedModel(deps.providerRegistry, selection);
    },
    getModelOption: (selection) => getRegistryBackedModel(deps.providerRegistry, selection),
    listThoughtLevels: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? [...(registryState.selection?.model.config.optionSpecs.reasoningLevel.values ?? [])]
        : [];
    },
  } satisfies Partial<SessionFacade>;
}
