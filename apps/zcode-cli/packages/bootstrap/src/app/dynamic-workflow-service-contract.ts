import type {
  CollaborationMode,
  TraceContext,
  DynamicWorkflowRunPort,
  DynamicWorkflowRunProgressPayload,
  ExecutionPort,
  FileSystemPort,
  Logger,
  SessionId,
  ModelRequestAdmission,
  ModelSelection,
  ToolArtifactStorePort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type {
  ActorSubmitProfile,
  ActorRef,
  JournalStorePort,
  PersonaSpec,
} from "@zcode/dynamic-workflow";
import { type DynamicWorkflowTaskLinkStore } from "./dynamic-workflow-run-journal.js";
import { type DynamicWorkflowRunSettledNotice } from "./dynamic-workflow-run-lifecycle.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-port.js";
import type { WorkflowSubagentPermissionMode } from "./workflow-actor-permission.js";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/** actor runtime 工厂的输入。runId 在内，因为会话 id 与 task link 都要 run 作用域。 */
export interface DynamicWorkflowActorRuntimeInput {
  runId: string;
  sessionId: SessionId;
  actor: ActorRef;
  persona: PersonaSpec;
  submitPort: WorkflowSubmitPort;
  /**
   * 该 actor 的 submit profile：`untyped` 不注入
   * submitPort（无工具），`mono` 注入端口 + typed 声明，`generic` 只注入端口。工厂是这条映射的
   * 唯一落点（与子代理工具面的固定 disallowlist 同一处 seam）。
   */
  submitProfile: ActorSubmitProfile;
  /**
   * 会话级升级端口：注入即为该 actor 会话注册 `escalate`
   * 工具，与 submitPort 完全同构。**恒在场**，不做 opt-in——最可能撞上未预见之墙的 actor
   * 恰是作者没标记的那一个。
   */
  escalatePort: WorkflowEscalatePort;
  /**
   * 这个 actor 上一次解析出的模型（journal 里的 `resolvedModel`，`providerId/modelId`），
   * 只有 resume 会带上它。没有 {@link DynamicWorkflowActorRuntimeInput.runSubagentModel} 时工厂
   * 必须优先于父会话模型采用它：见 `workflow-actor-model.ts` 里 pin 的理由（persona 冻结不变式
   * 的持久化那一半）。
   */
  pinnedModel?: string;
  /**
   * 本 run 自己的子代理模型（`CreateWorkflow` / `AmendWorkflow` 的 `subagent_model`，从
   * journal 的 `run-launched` 事件解析回来）。整条选择，含 reasoning 档位。
   *
   * 优先级**最高**，在 {@link DynamicWorkflowActorRuntimeInput.pinnedModel} 与父会话模型之上
   * （workflow-actor-model.ts 的 `workflowActorModelPolicy`）：这一条是用户对这一次 run 的显式
   * 表态，pin 只守没有它时的隐式缺省。只管子代理、不动主代理。缺席即跑在 pin 或会话模型上。
   */
  runSubagentModel?: ModelSelection;
  /**
   * 这个 actor 的 persona 点名的模型，已按本 run 的绑定表（run-launched 的 `modelBindings`）解析成整条
   * 选择（docs/dynamic-workflow/launch.md「Models the script names」）。优先级在 {@link runSubagentModel}
   * 之上：它是为这一个子代理写下的选择。缺席即 persona 没点名模型。
   */
  actorModel?: ModelSelection;
  /**
   * 本 run 子代理的权限模式（journal 的 `run-launched` 上的那一个；docs/dynamic-workflow/launch.md
   * 「Permissions inside a run」）。工厂让 actor 跑在这个模式上（workflow-actor-permission.ts），
   * 缺席即 YOLO。
   */
  subagentPermissionMode?: WorkflowSubagentPermissionMode;
  /**
   * 该 actor runtime 的模型请求准入端口（docs/dynamic-workflow/concurrency.md「One ticket per request attempt」）：
   * driver 在治理器端口在场时给出；工厂原样放进 runtime deps。缺席即不受闸门约束。
   */
  modelRequestAdmission?: ModelRequestAdmission;
}

export interface DynamicWorkflowRunServiceDeps {
  /** durable journal（dwf_* 表）。缺失即不构造本服务，见文件头不变式 3。 */
  journal: JournalStorePort;
  /**
   * 发起锚点的解析：给出 submit 那一刻父 runtime 活动轮的
   * inputId；`trace.turnId` 与活动轮不一致或没有活动轮时回 `undefined`（submit 侧兜底铸值）。
   * 缺席即宿主没有「当前轮」概念（CLI、测试装配）。
   */
  resolveLaunchInputId?: (trace: TraceContext) => string | undefined;
  /**
   * 本服务实例的父会话 id（= 本 app 的会话，见 create-app.ts）。
   *
   * 它是**孤儿收敛与枚举的作用域**，所以不是可选项：缺席只剩两条路——全局清扫（会把同进程
   * 兄弟会话正在飞的 run 标死，两者共用同一个 sqlite、各有各的内存注册表）或干脆不收敛
   * （就是那个「run 永远停在 running」的 bug）。宁可让接线错误在编译期出现。
   */
  parentSessionId: string;
  /**
   * 父会话**此刻**的权限模式（create-app 接 `runtime.getMode()`）。只在建 run 那一世读一次
   * （submit / amend），记进 `run-launched`（docs/dynamic-workflow/launch.md
   * 「Permissions inside a run」）；resume 只读事件、不读它。惰性：run service 先于 runtime 构造。
   * 缺席即宿主没有模式概念（CLI 测试装配），子代理照旧 YOLO。
   */
  permissionMode?: () => CollaborationMode;
  /** world-read（files.glob / files.read / files.grep）落到的文件系统端口。 */
  fileSystemPort: FileSystemPort;
  /** git.* world-read 落到的子进程执行端口（cwd = run 的工作区）。 */
  executionPort: ExecutionPort;
  /**
   * 用户面产物（`artifact.file` / `artifact.markdown`）的字节落点，原样转交 driver。⚠ 这里的 artifact 指**交付给用户看的
   * 产出**，不是引擎内部那个顶层返回值。
   *
   * **可选**：不带 store 的装配（测试、最小 stub）照旧能跑 run，只是内容成员会以命名的
   * `ArtifactStoreUnavailable` 拒绝——一条脚本可 catch 的失败，不是静默降级。会话作用域
   * 用的是本服务的 {@link DynamicWorkflowRunServiceDeps.parentSessionId}（= 本 app 的会话，
   * 也就是父会话）。
   */
  artifactStore?: ToolArtifactStorePort;
  /** 造一个 actor 的 child AgentRuntime（生产包装 createScriptWorkflowAgentRuntime）。 */
  createActorRuntime: (input: DynamicWorkflowActorRuntimeInput) => AgentRuntime;
  /** actor 会话的 task link 落库面；缺席则跳过建 link（会话本身仍落库）。 */
  taskLinkStore?: DynamicWorkflowTaskLinkStore;
  /**
   * actor 会话的转录存取面（生产就是 session store 本身）。driver 用它做两件事：ask 边界记账的
   * 计数，与 amend-resume 分歧 actor 的转录截断复制。
   *
   * 缺席时边界记账整体缺席——run 照常跑完，只是**不能再作为修订的前驱**（service 的
   * 「无 marker 前驱整体拒绝」门会挡下来）。可选而非必填，是因为不带会话存储的装配里本来就没有
   * 转录可数；带种子的会话创建在缺席时由 driver 大声失败。
   */
  actorTranscriptStore?: ActorTranscriptStore;
  /**
   * 引擎事件钩子：交出的是**已经准备好的会话事件载荷**（有界 payload + journal sequence +
   * 两个派生字段），调用方只负责把它追加到父会话（create-app 接 runtime 的 record 方法）。
   *
   * 为什么由本服务准备而不是让调用方拼：sequence 与 spentTokens 都只能从 journal 读，
   * 而 journal 是本服务的依赖；actor 会话 id 只能由铸造它的那个函数算。把这三件事推给
   * 调用方，等于把三个契约复制到一个没有 journal 的层里。
   *
   * 第二个参数是**路由**信息，刻意与载荷分开：`parentSessionId` 决定事件该落到哪个会话，
   * 但它不属于载荷本身（事件已经在那个会话里了，再存一份是冗余）。调用方据它做身份闸门，
   * 见 {@link createDynamicWorkflowRunProgressSink}。
   */
  onRunEvent?: (
    progress: DynamicWorkflowRunProgressPayload,
    routing: { parentSessionId?: string },
  ) => void;
  logger?: Logger;
  /** 注入并发度探测，供 caps 默认值测试固定双核（地板必须是 1）。 */
  availableParallelism?: () => number;
  /**
   * 进程级并发治理器的窄端口。原样转交 driver：
   * 有效并发 = min(本 run 的 caps.maxConcurrency, 该 provider key 的共享 live cap)。缺席即只有
   * per-run 上界（测试装配、无治理器的宿主）。
   */
  concurrency?: WorkflowConcurrencyPort;
  /**
   * 把一次启动登记为父 runtime 的**常驻阻塞工作**。
   *
   * 引擎活在会话 App 的闭包里、不进 runtime task registry，而常驻池当时
   * 只读 registry——一个仍在跑的 run 被读成 idle，App 被关闭，resume 起了第二个引擎。登记走
   * runtime 唯一的那个口（`trackResidencyBlockingWork`），常驻池因此不必再对 sidecar 做猜测。
   *
   * 缺席即宿主没有常驻概念（CLI 一次性执行、测试装配）：run 照常跑完，只是不挡关闭。
   */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /**
   * driver 的时钟与定时器：run 级
   * stall 时钟与瞬态失败的退避重驱都读它。**只为测试注入**（故障矩阵把 2s→60s 的重驱曲线与
   * 20 分钟的 stall 窗缩到毫秒级）；生产装配永不设置，缺席即 driver 用真时间。
   */
  driverClock?: AgentRuntimeWorkflowDriverDeps["clock"];
  /**
   * 按内联规则铸一份草稿（docs/dynamic-workflow/launch.md「The draft after a fill」）：一次补全
   * 落在一个没有草稿的 run 上时，有效脚本要有个家。规则（slug、`-2`/`-3` 顺延、独占创建、目录
   * 的 `.gitignore`）只在工具层有一份实现，宿主装配时注入，本服务不复制它。写不成回 `undefined`
   * （绝不抛）。缺席即不铸——补全照常成功，只是回话里没有路径。
   */
  writeWorkflowDraft?: (input: {
    cwd: string;
    name: string;
    source: string;
  }) => Promise<{ path: string } | undefined>;
}

export /**
 * 本服务的完整面：{@link DynamicWorkflowRunPort}（引擎 / 工具层用）加两条**会话级**生命周期
 * 读面。后者的唯一消费者是宿主的 provider registry 安全边界：
 * 子代理共用父会话的 live adapter，一个在飞的 run 就是父会话的一段 active Loop——
 * registry replace 必须等它结算。
 */
interface DynamicWorkflowRunService extends DynamicWorkflowRunPort {
  /** 此刻仍未结算的 run 数（registry 里 `terminal === undefined` 的条目）。 */
  countLiveRuns(): number;
  /**
   * 订阅结算：每个 run 进终态（completed / errored / stopped，含 launch 前失败）后恰好通知
   * 一次，簿记已经完成（计数已经扣掉它）。返回退订函数。监听器抛错只记日志，不影响结算。
   */
  subscribeRunSettled(listener: (notice: DynamicWorkflowRunSettledNotice) => void): () => void;
  /**
   * 停下本服务拥有的每一个在飞 run 并等它们结算（文件头不变式 7）。**不在 contracts 的
   * {@link DynamicWorkflowRunPort} 上**：它是宿主 App 的生命周期动作，不是引擎与工具层的能力。
   * 幂等——第二次调用返回同一个 promise，不再 abort 任何东西。
   */
  close(): Promise<void>;
}
