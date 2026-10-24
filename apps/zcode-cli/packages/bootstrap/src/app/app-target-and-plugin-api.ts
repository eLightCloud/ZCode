import type {
  GoalStatus,
  InputHistoryEntry,
  InputHistoryKind,
  PluginLoadOutcome,
  PluginReferenceCatalog,
  SessionGoal,
  SkillLoadOutcome,
  TurnInputIntentMetadata,
} from "@zcode/contracts";

import type { TurnResult } from "@zcode/core";

import type { ZCodeModelOption } from "@zcode/shared";

import type {
  PromptInput,
  SubmitPromptOptions,
  ZCodePluginSetResult,
  ZCodePluginUninstallResult,
} from "./app-option-types.js";
export interface AppTargetAndPluginApi {
  setTarget(input: {
    objective: string;
    /** 用户提交的原始 goal 命令；target 仍只存 objective，聊天行按该文本展示。 */
    displayText?: string;
    status?: GoalStatus;
    tokenBudget?: number | null;
    intent?: TurnInputIntentMetadata;
  }): Promise<SessionGoal>;

  updateTargetStatus(status: GoalStatus): Promise<SessionGoal | null>;

  clearTarget(): Promise<boolean>;

  continueActiveTarget(options?: SubmitPromptOptions): Promise<TurnResult | null>;

  recordInputHistory(
    input: PromptInput,
    kind?: InputHistoryKind,
  ): Promise<InputHistoryEntry | null>;

  recallPreviousInputHistory(skip?: number): Promise<InputHistoryEntry | null>;

  listModels(): ZCodeModelOption[];

  listThoughtLevels(): string[];

  listPlugins(): Promise<PluginLoadOutcome>;

  setPluginEnabled(plugin: string, enabled: boolean): Promise<ZCodePluginSetResult>;

  uninstallPlugin(plugin: string): Promise<ZCodePluginUninstallResult>;

  /**
   * Session 冻结的 Plugin 身份 catalog。
   * 在 App 创建时由 resolveStartupPlugins 结果构建一次，之后只读；
   * `plugins/referenceCatalog` 带 sessionId 时以此为 session authority。
   */
  getPluginReferenceCatalog(): PluginReferenceCatalog;

  /** 当前 Session 的 AgentRuntime Skill 发现快照；冷恢复重建 runtime 后重新发现。 */
  getSkillCatalog(): Promise<SkillLoadOutcome>;
}
