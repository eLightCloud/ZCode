import { subagentProfilesFromSnapshot } from "../runtime-subagents/index.js";
import { ConfigResult } from "@zcode/adapters/config";
import { resolvePath } from "@zcode/adapters/config";
import { Logger } from "@zcode/contracts";
import type { TraceContext } from "@zcode/contracts";
import { resolveZCodeRuntimeEnv } from "@zcode/shared";
import { StartupTimer } from "../startup-logging.js";
import type { ZCodeAppOptions } from "./types.js";
import { getCliStorageRoot } from "./paths.js";
import { getModelIoDir } from "./paths.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import { resolveBundledSkillRoots } from "./bundled-skills.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { loadPluginAgentTemplates } from "../subagents.js";
import { loadZCodeAgentProfiles } from "../subagents.js";
import { resolvePluginAgentProfiles } from "../subagents.js";
import { resolveStartupPlugins } from "./startup-marks.js";

export async function resolveAppStartupSources(
  configResult: ConfigResult,
  options: ZCodeAppOptions,
  traceContext: TraceContext,
  logger: Logger,
  workingDirectory: string,
  startupTimer: StartupTimer,
): Promise<{
  cliStorageRoot: string;
  storageRoot: string;
  modelIoDir: string;
  pluginOutcome: ReturnType<typeof resolveStartupPlugins>;
  builtInMcpServers: ReturnType<typeof resolveBuiltInNodeReplMcpServers>;
  pluginRuntimeFeatures: ReturnType<typeof resolvePluginRuntimeFeatures>;
  zcodeSubagentProfileOutcome:
    | Awaited<ReturnType<typeof loadZCodeAgentProfiles>>
    | ReturnType<typeof subagentProfilesFromSnapshot>;
  subagentProfiles: Awaited<ReturnType<typeof loadZCodeAgentProfiles>>["profiles"];
  pluginTemplates: ReturnType<typeof loadPluginAgentTemplates>;
  bundledSkillRoots: ReturnType<typeof resolveBundledSkillRoots>;
}> {
  const storageRoot = resolvePath(configResult.config.storage.dir);
  const cliStorageRoot = getCliStorageRoot(storageRoot);
  const modelIoDir = getModelIoDir(
    cliStorageRoot,
    resolveZCodeRuntimeEnv(options.env ?? process.env) === "development",
  );
  // 初始化与父轮必须使用同一 Host 来源，避免 CLI storage.dir 的另一份定义在首轮消失。
  const hostSubagentSnapshot = await options.readSubagentRuntimeConfig?.({
    signal: new AbortController().signal,
    traceContext,
  });
  const zcodeSubagentProfileOutcome = hostSubagentSnapshot
    ? subagentProfilesFromSnapshot(hostSubagentSnapshot)
    : await loadZCodeAgentProfiles({
        logger,
        storageRoot,
        workingDirectory,
        additionalDirectories: options.additionalDirectories,
      });
  const zcodeSubagentProfiles = zcodeSubagentProfileOutcome.profiles;
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: options.env,
    logger,
    options,
    startupTimer,
    workingDirectory,
  });
  // 随 CLI 内置的技能包（dynamic-workflows 等）：不属于任何插件，用户无法停用或卸载。
  const bundledSkillRoots = resolveBundledSkillRoots({ cliStorageRoot, logger });
  const pluginTemplates = loadPluginAgentTemplates({ logger, plugins: pluginOutcome.plugins });
  const pluginSubagentProfiles =
    hostSubagentSnapshot?.kind === "built-in-fallback"
      ? []
      : resolvePluginAgentProfiles(
          {
            logger,
            plugins: pluginOutcome.plugins,
            reservedProfileNames: zcodeSubagentProfiles.map((profile) => profile.name),
            modelSelectionOverrides: zcodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
          },
          pluginTemplates,
        ).profiles;
  const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);
  const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
    pluginOutcome,
    workingDirectory,
  });
  // 用户目录已在 loader 前完成原地迁移；不能给项目/插件旧身份加内存兼容旁路。
  const subagentProfiles = [...zcodeSubagentProfiles, ...pluginSubagentProfiles];
  return {
    cliStorageRoot,
    pluginOutcome,
    builtInMcpServers,
    pluginRuntimeFeatures,
    zcodeSubagentProfileOutcome,
    subagentProfiles,
    storageRoot,
    modelIoDir,
    pluginTemplates,
    bundledSkillRoots,
  };
}
