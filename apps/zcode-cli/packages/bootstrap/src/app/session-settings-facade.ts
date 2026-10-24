import { readUserModelSelection } from "./session-model-selection.js";
import { updateUiLocaleInFileConfig } from "@zcode/adapters/config";
import type { SupportedLocale } from "@zcode/contracts";

import { traceContextToLogContext, type CollaborationMode } from "@zcode/contracts";

import { type ModelSelection } from "@zcode/provider";

import { getLocaleConfigPath } from "./locale-selection.js";

import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

import {
  requireRegistryThoughtLevel,
  resolveRegistryOwnedModelSelection,
  resolveRegistryOwnedSelection,
  resolveRegistryThoughtLevel,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";

import type { CreateSessionFacadeDeps, SessionFacade } from "./session-facade-contract.js";

import {
  formatLegacyRuntimeModelValue,
  persistSessionModelSelection,
} from "./session-model-selection.js";

export function createSessionSettingsFacade(
  deps: CreateSessionFacadeDeps,
  currentRegistrySelection: () =>
    | { owned: false }
    | {
        owned: true;
        registry: ProviderRegistryModelSource;
        selection?: ResolvedRegistrySelection;
      },
  sessionState: {
    closePromise: Promise<void> | undefined;
    currentLocale: SupportedLocale;
    appProvidedToolNames: string[];
  },
): Pick<SessionFacade, "setMode" | "setModel" | "setThoughtLevel" | "setLocale"> {
  return {
    setMode: async (mode: CollaborationMode) => {
      const previousMode = deps.runtime.getMode();
      const session = await deps.sessionStore.getSession(deps.sessionId);
      // 群模式属于任务授权；不能写入工作区默认模式，让其他群或私聊继承。
      if (session?.permission?.scope === "session") {
        await deps.sessionStore.updateSession({
          id: deps.sessionId,
          permission: { ...session.permission, mode },
        });
      }
      await deps.runtime.setExecutionState({ mode }, deps.traceContext);
      if (deps.localSettingStore && session?.permission?.scope !== "session") {
        try {
          await deps.localSettingStore.saveProjectPermissionMode({
            mode: deps.runtime.getMode(),
            projectID: deps.projectID,
          });
        } catch (error) {
          deps.logger.warn("Project mode preference write failed", {
            ...traceContextToLogContext(deps.traceContext),
            error: error instanceof Error ? error.message : String(error),
            event: "local_setting.permission_mode.write_failed",
            mode,
            module: "bootstrap",
            projectId: deps.projectID,
            status: "failed",
          });
        }
      }
      deps.logger.info("Session mode updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.mode.updated",
        mode,
        module: "bootstrap",
        previousMode,
        status: "completed",
      });
      return {
        mode: deps.runtime.getMode(),
        previousMode,
        traceId: deps.traceContext.traceId,
      };
    },
    setModel: async (modelId, options) => {
      // 配置命令已提交完整 Selection；转成字符串会丢档位。先整体校验再一次
      // 更新/保存，非法档位不能留下已换模型的半次修改。旧字符串入口保留只改身份语义。
      const registrySelection =
        typeof modelId === "string"
          ? resolveRegistryOwnedSelection(
              deps.providerRegistry,
              modelId,
              deps.configuredDefaultModelSelection,
              { allowMissingReasoning: true },
            )
          : resolveRegistryOwnedModelSelection(deps.providerRegistry, modelId);
      if (!registrySelection) {
        throw new Error(`Provider Registry 中不存在 Model: ${modelId}`);
      }
      const previousSelection = readUserModelSelection(deps);
      const previousModel = formatLegacyRuntimeModelValue(previousSelection);
      const model = formatLegacyRuntimeModelValue(registrySelection.selection);
      const sessionSelection: ModelSelection = {
        providerId: registrySelection.selection.providerId,
        modelId: registrySelection.selection.modelId,
        ...(typeof modelId !== "string" && registrySelection.selection.options
          ? { options: { ...registrySelection.selection.options } }
          : {}),
      };
      if (deps.cliDefaultSelection && !options?.transient) {
        deps.cliDefaultSelection.set(sessionSelection);
      } else {
        deps.runtime.setSessionModelSelection(sessionSelection);
      }
      // transient 切换不产出 modelChange 聊天通知：应用/还原成对出现会刷出两条无意义通知。
      if (!options?.transient) {
        deps.runtime.recordPendingModelChange({
          fromModel: previousSelection,
          fromModelLabel: previousModel,
          toModel: sessionSelection,
          toModelLabel: model,
        });
        await persistSessionModelSelection(deps);
      }
      deps.logger.info("Session model updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.model.updated",
        model,
        module: "bootstrap",
        previousModel,
        status: "completed",
      });
      return {
        model,
        previousModel,
        traceId: deps.traceContext.traceId,
      };
    },
    setThoughtLevel: async (level) => {
      const registryState = currentRegistrySelection();
      if (registryState.owned) {
        const currentSelection = readUserModelSelection(deps);
        if (!currentSelection) throw new Error("Select a model before choosing reasoning effort");
        const registrySelection =
          registryState.selection ??
          resolveRegistryOwnedModelSelection(registryState.registry, {
            providerId: currentSelection.providerId,
            modelId: currentSelection.modelId,
          })!;
        const previousThoughtLevel = resolveRegistryThoughtLevel(
          registrySelection,
          currentSelection.options?.reasoningLevel,
        );
        const thoughtLevel = requireRegistryThoughtLevel(registrySelection, level);
        const nextSelection = {
          ...currentSelection,
          options: {
            ...currentSelection.options,
            reasoningLevel: thoughtLevel,
          },
        };
        if (deps.cliDefaultSelection) deps.cliDefaultSelection.set(nextSelection);
        else deps.runtime.setSessionModelSelection(nextSelection);
        await persistSessionModelSelection(deps);
        deps.logger.info("Session reasoning effort updated", {
          ...traceContextToLogContext(deps.traceContext),
          event: "session.reasoning_effort.updated",
          module: "bootstrap",
          previousThoughtLevel,
          status: "completed",
          thoughtLevel,
        });
        return {
          previousThoughtLevel,
          thoughtLevel,
          traceId: deps.traceContext.traceId,
        };
      }
      throw new Error("当前 Session Model 不属于 Provider Registry");
    },
    setLocale: async (locale) => {
      const previousLocale = sessionState.currentLocale;
      const configPath = getLocaleConfigPath(deps.configResult);
      const persisted = await updateUiLocaleInFileConfig(configPath, locale);
      sessionState.currentLocale = deps.resolveUiLocale(locale);
      deps.configResult.config.ui.locale = sessionState.currentLocale;
      deps.logger.info("Session locale updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.locale.updated",
        locale: sessionState.currentLocale,
        module: "bootstrap",
        previousLocale,
        requestedLocale: locale,
        status: "completed",
      });
      return {
        configPath: persisted.path,
        locale: sessionState.currentLocale,
        previousLocale,
        requestedLocale: locale,
        traceId: deps.traceContext.traceId,
      };
    },
  } satisfies Partial<SessionFacade>;
}
