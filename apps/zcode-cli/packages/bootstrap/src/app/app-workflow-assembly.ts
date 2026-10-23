import type { RuntimeModelFactory } from "./provider-registry-model-runtime.js";

import { ConfigResult } from "@zcode/adapters/config";

import {
  AgentRuntime,
  AgentRuntimeConfig,
  PermissionService,
  writeWorkflowDraft,
} from "@zcode/core";

import { ModelTelemetryBootstrap } from "@zcode/telemetry";

import {
  BrowserControlPort,
  ExecutionPort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  Logger,
  McpPort,
  PluginLoadOutcome,
  SessionId,
  SessionStorePort,
  ToolArtifactStorePort,
  type TraceContext,
} from "@zcode/contracts";

import type { ZCodeAppOptions } from "./types.js";

import {
  createDynamicWorkflowRunService,
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
} from "./dynamic-workflow-run-service.js";

import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";

import { createDynamicWorkflowRunProgressSink } from "./dynamic-workflow-run-progress-sink.js";

import { createScriptWorkflowAgentRuntime } from "./script-workflow-child-runtime.js";

import { workflowActorModelPolicy } from "./workflow-actor-model.js";

import {
  workflowActorInteractionDescription,
  workflowActorPermissionPolicy,
} from "./workflow-actor-permission.js";

import { workflowActorToolPolicy } from "./workflow-actor-tools.js";

export function createAppWorkflowRuntime(
  sessionStore: SessionStorePort,
  logger: Logger,
  workflowConcurrencyGovernor: ReturnType<typeof getWorkflowConcurrencyGovernor>,
  getRuntime: () => AgentRuntime,
  modelTelemetry: ModelTelemetryBootstrap,
  options: ZCodeAppOptions,
  appVersion: string,
  artifactStore: ToolArtifactStorePort,
  configResult: ConfigResult,
  fileSystemPort: FileSystemPort,
  httpClientPort: HttpClientPort,
  imageProcessorPort: ImageProcessorPort,
  mcpPort: McpPort | undefined,
  modelFactory: RuntimeModelFactory,
  permissionService: PermissionService,
  pluginOutcome: PluginLoadOutcome,
  runtimeConfig: AgentRuntimeConfig,
  sessionId: SessionId,
  storageRoot: string,
  workingDirectory: string,
  browserControlPort: BrowserControlPort | undefined,
  traceContext: TraceContext,
  executionPort: ExecutionPort,
): ReturnType<typeof createDynamicWorkflowRunService> | undefined {
  const dynamicWorkflowJournal = resolveDynamicWorkflowJournalStore(sessionStore, logger);
  const dynamicWorkflowRunPort =
    dynamicWorkflowJournal === undefined
      ? undefined
      : createDynamicWorkflowRunService({
          concurrency: workflowConcurrencyGovernor,
          createActorRuntime: ({
            actor,
            persona,
            pinnedModel,
            runSubagentModel,
            actorModel,
            subagentPermissionMode,
            sessionId: actorSessionId,
            submitPort,
            submitProfile,
            escalatePort,
            modelRequestAdmission,
          }) =>
            createScriptWorkflowAgentRuntime({
              childSessionId: actorSessionId,
              configOverrides: {
                // persona 的身份（有效名 + system）→ context builder 的工作流子代理路径。
                // 匿名 / 无 system 时字段缺席，builder 据此省略 named 从句与 persona 段。
                workflowActor: {
                  ...(persona.name === undefined ? {} : { name: persona.name }),
                  ...(persona.system === undefined ? {} : { persona: persona.system }),
                },
                // actor 的工具面是减法（全集减去 plan 与越权的元工具），只能经 configOverrides
                // 表达（request.opts.tools 只有 allowlist）。
                ...workflowActorToolPolicy(),
                // 权限面：子代理跑发起会话的权限模式（plan 除外），未记录即 YOLO
                // （docs/dynamic-workflow/launch.md「Permissions inside a run」）。
                ...workflowActorPermissionPolicy(subagentPermissionMode),
                // 模型面：`runSubagentModel` 是本 run 自己的选择（`subagent_model`），在场时整条
                // 覆盖，排在 pin 之上——主代理不受它影响。没有它也没有 pin 就不覆盖——child runtime
                // 的基线本就是父会话当前模型（工厂的基线，见 script-workflow-child-runtime.ts）。
                // resume 带来的 pin 钉住上一次实际跑的模型（persona 冻结不变式的持久化那一半，见
                // workflow-actor-model.ts 的优先级表）；parentSelection 取父会话**当前**的选择，
                // 与工厂基线同源，pin 比对才不会漂移。
                ...workflowActorModelPolicy(
                  {
                    parentSelection: getRuntime().getSessionModelSelection(),
                    ...(runSubagentModel === undefined ? {} : { runSelection: runSubagentModel }),
                    // persona 点名的模型（脚本里的 `agent(…, { model })`）排在 run 选择之上。
                    ...(actorModel === undefined ? {} : { actorSelection: actorModel }),
                  },
                  pinnedModel,
                ).configOverrides,
              },
              deps: {
                agentTelemetry: modelTelemetry.agentExecution,
                appOptions: options,
                appVersion,
                artifactStore,
                configResult,
                fileSystemPort,
                httpClientPort,
                imageProcessorPort,
                logger,
                mcpPort,
                // 父会话的 model factory：actor 与主 turn 从同一份 Registry 视图造 Model，
                // 不各自冻结一份。
                modelFactory,
                permissionService,
                pluginSkillRoots: pluginOutcome.skillRoots,
                runtime: getRuntime(),
                runtimeConfig,
                sessionId,
                sessionStore,
                storageRoot,
                workingDirectory,
              },
              // persona 不再经 request.opts.systemPrompt 整段替换子代理的系统提示，而是经
              // workflowActor 叠加到基座之上。
              // request 在这里只是工厂签名的占位：opts 为空即「不覆盖任何东西」。
              request: { opts: {} } as never,
              // 权限窗的来源徽标点名这个子代理：`<persona 名> (<siteId>@<ordinal>)`。
              interactionDescription: workflowActorInteractionDescription({ actor, persona }),
              // 子代理的 Browser Use：父会话的端口，由工厂经 forChildSession 派生子端口（tab 归属是
              // actor 自己的 sessionId）。actor runtime 在 run dispose 时 closeBrowserSession，
              // 那一步连 tab 一起关并撤销登记（dynamic-workflow/docs/execution-engine.md「Subagent sessions」）。
              ...(browserControlPort === undefined ? {} : { browserControlPort }),
              traceContext,
              // submit profile → submit_result 形态：
              // `untyped` 不注入端口（core 的注册门是端口在场，于是没有这个工具——全 untyped 的子代理
              // 本来就无处可提交）；`mono` 注入端口 + typed 声明；`generic` 只注入端口（通用声明）。
              ...(submitProfile.kind === "untyped" ? {} : { workflowSubmitPort: submitPort }),
              // 展开：dwf 的 JsonSchema 是无索引签名的 interface，contracts 的是 Record；
              // 字面量展开拿到隐式索引签名，不必在两包之间造一个转换函数。
              ...(submitProfile.kind === "mono"
                ? { workflowSubmitSchema: { ...submitProfile.schema } }
                : {}),
              // 升级端口与 submit 端口同进同出：两者都是 actor 会话的控制通道，而端口在场
              // 就是 core 侧的注册门。恒传（端口在 run service 里恒被构造），不做 opt-in——
              // 最可能撞上未预见之墙的 actor 恰是作者没标记的那一个。
              workflowEscalatePort: escalatePort,
              // 请求级准入端口：driver 在治理器在场时给出，runner 每次尝试先过闸门。
              ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
            }),
          // 边界记账与转录截断都读写 actor 会话的消息，走的必须是同一个 store。
          actorTranscriptStore: sessionStore,
          // 用户面产物的字节落点：与主会话、workflow 子
          // 代理共用同一个 tool-artifact store，产物因此和别的大结果落在同一棵目录树下。
          artifactStore,
          executionPort,
          fileSystemPort,
          journal: dynamicWorkflowJournal,
          logger,
          // 进度投影的接缝：一条引擎事件 → 一条父会话的会话事件 → v4 的 workflowRuns 状态键。
          // 走 runtime 的 append 链路（而不是直接推 eventSink）是必需的：只有它同时做持久化、
          // 补 sequenceNumber 与扇出，冷恢复与 replayable 重连因此免费。
          //
          // 身份闸门、runtime 未就绪与 append 失败三条降级路径都在这个汇里（连同它们的单测），
          // 见 dynamic-workflow-run-progress-sink.ts 的文件头。
          onRunEvent: createDynamicWorkflowRunProgressSink({
            // 惰性：run service 在 runtime 构造之前就建好了（它是 AgentRuntime 的依赖之一）。
            getRuntime,
            logger,
            sessionId,
          }),
          // 孤儿收敛的作用域：本 app 的会话。构造时把**这个会话**留在 journal 里的非终态
          // run（死进程的遗物）收敛成 failed；兄弟会话的在飞 run 因此绝不会被误伤。
          parentSessionId: sessionId,
          // 补全落在没有草稿的 run 上时铸草稿（docs/dynamic-workflow/launch.md「The draft after a
          // fill」）：内联规则只在工具层有一份实现，这里注入而不是让 run service 复制它。
          writeWorkflowDraft,
          // 建 run 那一刻会话的权限模式（记进 run-launched，子代理随之）。
          // 惰性同 onRunEvent：启动只来自工具调用或 v4 命令，那时 runtime 必已就绪。
          permissionMode: () => getRuntime().getMode(),
          // 在飞的引擎把本会话钉成常驻。2026-09-15 的 bug：引擎不进 runtime task registry，
          // 常驻池把带着在飞 run 的 App 按 idle（10 分钟）关掉，resume 又起了第二个引擎。
          // 惰性取 runtime 同 onRunEvent：run service 是 AgentRuntime 的依赖，构造更早；
          // 而启动只来自工具调用或 v4 命令，那时 runtime 必已就绪。
          registerResidencyBlockingWork: (work) => {
            void getRuntime().trackResidencyBlockingWork(work);
          },
          // 发起锚点：CreateWorkflow 在父会话的活动轮里执行，
          // 那一轮的 inputId 就是子代理 agent_step 要挂的 message。trace.turnId 对不上活动轮
          // （理论上不该发生）就交回 submit 侧兜底铸值，绝不把别的轮的 id 记成锚点。
          resolveLaunchInputId: (trace) => {
            const active = getRuntime().getActiveTurnInfo();
            return active !== undefined && active.turnId === trace.turnId
              ? active.inputId
              : undefined;
          },
          ...(isDynamicWorkflowTaskLinkStore(sessionStore) ? { taskLinkStore: sessionStore } : {}),
        });
  return dynamicWorkflowRunPort;
}
