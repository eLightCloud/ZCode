/** Journal / live engine event contract; re-exported through the existing engine types entry. */
import type { ArtifactContentOp } from "../facade/registry.js";
import type { AskProgress } from "./ask-observation-types.js";
import type {
  ActorRef,
  ArtifactVersionRecord,
  AskWaitInfo,
  Caps,
  ConcurrencyChange,
  ImportCloseCause,
  InstanceRef,
  NodeKind,
  NodeOutcome,
  PersonaSpec,
  RunStallInfo,
  RunStatus,
  RunStopReason,
  Violation,
  WorkflowErrorJson,
} from "./types.js";

/**
 * run 事件词汇表（Boundary C）。每个值得观察的状态迁移都发一个事件。
 * `compaction` 为长上下文压缩预留——v1 从不发出，仅占位以便将来非破坏地加入。
 */
export type RunEvent =
  | { type: "run-started"; runId: string; caps: Caps }
  /**
   * 发起 run 的那一轮：`inputId` 是父会话里发起这次
   * run 的 turn 的 inputId（中枢直接启动为铸出的 UUID v7）。**只在建 run 那一世记一次**，紧跟第一条
   * `run-started`；resume 再发 `run-started` 时不再发它——同 run 的子代理 step 因此永远挂在同一个
   * message 下。零 SQL：锚点活在 journal 事件里，不在 dwf_run 列上（刻意不做迁移）。
   * `phaseNames` 是脚本声明的阶段表（声明序），由提交方从因果图填入；侧栏迷你轨道据此画出前方
   * 的站点。同样只记一次，
   * 冷重放免费重建；脚本没有 `phase()` 标记时缺席。
   * `subagentModel` 是本 run 的子代理跑在哪个模型上，规范形 `providerId/modelId[$reasoningLevel]`。与锚点、阶段表同一路宿主元数据：引擎**从不读它**，
   * 只在建 run 那一世随这条事件记一次；宿主在 resume 与两条读面上从事件头读回同一个串
   * （子代理会话按「本字段 > resume pin > 父会话模型」定选型，bootstrap 的
   * workflow-actor-model.ts）。同样零 SQL——不在 `dwf_run` 列上。缺席即子代理跑在会话模型上。
   * `phaseAlongside` 与 `phaseNames` **按位置对齐**：`phaseAlongside[i]` 是进入 `phaseNames[i]` 时
   * strand 仍在跑的其他阶段的下标（下标落在同一张 `phaseNames` 里）。侧栏据此把并行的两站画成
   * 双线段；没有阶段并行时缺席，缺席就是「这条轨道是一条直线」。
   * `scriptPath` 是本 run 的脚本**来自哪个文件**（绝对路径）。与 `subagentModel` 逐条同规：引擎从不读、只在建 run 那一世
   * 记一次、零 SQL，宿主在两条读面上从事件头读回同一个串。缺席即这个 run 没有可编辑的脚本
   * 文件（草稿写不下去的项目、本特性之前发起的 run），模型面因此退回内联重提交的老话。
   * `subagentPermissionMode` 是本 run 子代理的权限模式（docs/dynamic-workflow/launch.md
   * 「Permissions inside a run」）：发起会话的权限模式名（plan 不带入）。与 `subagentModel`
   * 逐条同规：引擎从不读、只在建 run 那一世记一次、零 SQL，宿主在 resume 时从事件头读回并
   * 校验，据此让子代理以该模式运行。缺席或宿主不认得的值即子代理跑在 YOLO 上。
   */
  | {
      type: "run-launched";
      inputId: string;
      /** Opaque host provenance; the engine records it without interpreting credentials. */
      modelRequestPurpose?: "automation";
      toolCallId?: string;
      parentSessionId?: string;
      phaseNames?: string[];
      subagentModel?: string;
      subagentPermissionMode?: string;
      /**
       * 脚本里点名的每个模型名（逐字）→ 规范串 `providerId/modelId[$level]`
       * （docs/dynamic-workflow/launch.md「Models the script names」）。与 `subagentModel` 同一条路：
       * 提交方给出、建 run 那一世记一次、引擎从不读。脚本没点名任何模型时缺席。
       */
      modelBindings?: Record<string, string>;
      scriptPath?: string;
      phaseAlongside?: number[][];
      /**
       * `phaseNames` 里哪些下标是**未补全的留白**（docs/execution-engine.md「Holes」）：留白按名字
       * 占它在阶段表里的位置，侧栏据此把那一站画成虚线。与 `phaseAlongside` 同规对齐、同车同规
       * （提交方给出、引擎不读）；脚本没有留白时缺席。
       */
      holes?: number[];
    }
  /**
   * `phaseName` 记录实例出生时最近一次 `enterPhase` 指定的阶段名。
   * 只出现在**出生事件**上——actor 的 `actor-created`、
   * 节点的 `node-queued`、以及命中缓存（replay / amend-resume）时代替 queued 的
   * `node-settled { cached: true }`；其余 `node-*` 事件不带，reducer 沿用 `actorSiteId`
   * 的先例向前携带。标记之前出生的实例整个键缺席。
   *
   * 它**不是**发出这条事件时的当前阶段：node-queued 可能被 hold 规则推迟到下一个标记
   * 之后才发出，而出生时刻在上一个阶段。
   */
  | {
      type: "actor-created";
      actor: ActorRef;
      name?: string;
      persona?: PersonaSpec;
      phaseName?: string;
    }
  | {
      type: "node-queued";
      instance: InstanceRef;
      kind: NodeKind;
      actor?: ActorRef;
      actorSeq?: number;
      phaseName?: string;
      /**
       * 作者指令的**开头** {@link INSTRUCTIONS_HEAD_MAX_CHARS} 个字符（去两端空白，不加省略号），
       * 只在 ask 节点上在场。事件轨上「这个子代理在干什么」的唯一答案：完整指令只活在
       * `dwf_node.input_json` 里，而读面（run 详情、GetWorkflowRun）不为一行摘要去读那张表。
       *
       * 取的是**准入时刻**的指令，也就是引擎尾注追加之前的那一份——尾注是引擎的话，不是作者的。
       */
      instructionsHead?: string;
    }
  /**
   * 派发：driver 被告知开跑。ask 的这一条**重复它自己的出生事实**——`kind` / `actor` /
   * `phaseName` / `instructionsHead` 与该实例的 `node-queued` 逐字相同，`actorName` /
   * `actorPhaseName` 则是它那个子代理的 `actor-created` 带过的 `name` / `phaseName`。
   *
   * 为什么要重复一遍已经发过的事实：读面的表是**有界**的，而「重要」发生在派发这一刻，不在
   * 排队那一刻（docs/dynamic-workflow/presentation.md）。2000 个 agent 的 run 会在头几秒里把
   * 全部 `actor-created` / `node-queued` 发完，表被前 1024 个排队者占满、一个都还没结算，
   * 此后每一个**真正在跑**的实例都进不了表。带上出生事实，这条事件就是一次自足的出生：
   * 读面可以据它把实例连同它的子代理一起收进表，而不必回头去找那条早已被拒的 queued。
   *
   * 两个阶段名都是**出生戳**，不是发这条事件时的当前阶段：排队的 ask 会卡在并发上界后面，
   * 而脚本早已走进后面的阶段（打戳见 engine-phase-stamp.ts，读的是铸造点写下的那张表）。
   * world-read 的派发不带这些键：它紧跟着自己的 `node-queued` 发出，也没有子代理。
   */
  | {
      type: "node-dispatched";
      instance: InstanceRef;
      kind?: NodeKind;
      actor?: ActorRef;
      actorName?: string;
      actorPhaseName?: string;
      /**
       * 它那个子代理 persona 的 `model`（脚本里写的名字，逐字）：与 `actorName` 同理重复出生事实，
       * 让读面在派发这一刻收回表的子代理也带着它的模型（宿主据绑定表派生规范串）。
       */
      actorPersonaModel?: string;
      phaseName?: string;
      instructionsHead?: string;
    }
  | { type: "node-repairing"; instance: InstanceRef; attempt: number; violations: Violation[] }
  | { type: "node-nudged"; instance: InstanceRef }
  /**
   * 自适应并发的三个观察事件。与 escalation 同族：
   * 引擎核心不据它们做任何决策，它们只是 driver / 治理器观察到的事实经引擎 `record()` 落
   * journal + 扇出。`node-waiting` ⇄ `node-executing` 是 dispatched 之后、settled 之前的自环
   * （`executing` 由此成为**可观察**相位），不改变节点的 journal 记录
   * （不写 dwf_node）。
   */
  | ({ type: "node-waiting"; instance: InstanceRef } & AskWaitInfo)
  | { type: "node-executing"; instance: InstanceRef }
  | ({ type: "concurrency-changed" } & ConcurrencyChange)
  /**
   * 本 run **自己**的并发上界被就地改了（docs/dynamic-workflow/concurrency.md
   * 「Two bounds on a run」）：一次只带 `max_concurrency` 的修订作用在活着的 run 上，同一个
   * runId、不铸后继、在飞 ask 一个不丢。
   *
   * 与紧挨着的 `concurrency-changed` 分属**两条界**，别混：那条是进程级共享 cap 的治理器观察
   * （单位是模型请求，引擎只 record），这条是本 run 的在飞 ask 上界，且是一次**命令**的结果
   * ——换 caps、写 `dwf_run.caps_max_concurrency`、发这条事件在同一个同步步骤里发生，三者永远一致。
   * `previous` 是改之前的那一份：读面要说的是「8 → 2」，从单个 caps 值推不出来。
   */
  | { type: "run-caps-changed"; runId: string; caps: Caps; previous: Caps }
  | {
      type: "node-settled";
      instance: InstanceRef;
      outcome: NodeOutcome;
      cached?: boolean;
      error?: WorkflowErrorJson;
      /** 仅 `cached: true` 时在场：命中的节点没有 queued，这条就是它的出生事件。 */
      phaseName?: string;
      /**
       * 以下四个只在 **ask 的缓存命中**上在场（replay 命中与 amend 导入命中同一副姿态）：这条结算
       * 就是出生事件，所以它**重发出生事实**——`node-queued` 本会带的 `kind` / `actor` /
       * `actorSeq` / `instructionsHead`，与 `node-dispatched` 重发它们同一个理由：一个从没见过这条
       * 实例入队的读面（修订 run 从空表开始）也要知道这是谁的答案。缺了它们，一个全部 ask 都命中
       * 的子代理在读面上就是「待开始」。world 节点的缓存结算不带：它没有子代理。
       */
      kind?: NodeKind;
      actor?: ActorRef;
      actorSeq?: number;
      instructionsHead?: string;
      /**
       * 答案读自**前驱的转录**时在场（导入命中，或修订 run resume 时对一条导入行的重放），值是
       * 持有那段交换的会话（导入候选的 `transcriptSourceSessionId`）。本 run 没有为这次命中建会话，
       * transcript 读面要去这条会话里看（docs/dynamic-workflow/presentation.md「Subagent
       * transcripts」）。缺席即答案在本 run 自己的会话里产生过。
       */
      sourceSessionId?: string;
    }
  /**
   * 一条 ask 在一次 turn 解析时的进度。
   * 与 escalation / 并发那几个观察同族：**引擎核心不解释它**，只 `record()`——它不改任何调度
   * 决策、不进 inputHash、replay 不比对它。同一次 turn 的两条事件顺序是载荷性的：
   * 本条先于 `usage-updated`，于是读到新用量的人一定已经读到了挣来它的那次进度。
   */
  | ({ type: "node-progress"; instance: InstanceRef } & AskProgress)
  /** run 级 token 用量更新：直接携带已花总量（journal 的 spent_tokens 同步写入，二者永远相等）。 */
  | { type: "usage-updated"; spentTokens: number }
  | { type: "log"; message: string }
  /**
   * amend-resume 的导入缓存关闭了：某个 live 子代理即将
   * 改写工作区（`cause: "mutating-tool"`，`actorName` 是它的有效名），或一条 `world.run` live 执行
   * （`cause: "world-run"`）。每个 run 最多一条；修订 run 崩溃后 resume 据它恢复「门已关」——这是
   * 关门的**唯一**事实来源，不再由「曾有 ask live」推断。非修订 run 没有表可关，不发。
   */
  | {
      type: "import-cache-closed";
      instance: InstanceRef;
      cause: ImportCloseCause;
      actorName?: string;
    }
  /**
   * 控制流经过了一个 `phase("…")` 标记。**无站点、无 journal 行、无 driver 往返**——标记不是一步工作，它只是
   * 「跑到哪了」的一个刻度。`name` 是作者的原词（去两端空白，与分析器铸造阶段 id 的键同一）；
   * `ordinal` 按名字计数，**每次求值都发**：同名再入即 +1，分析器也正是把第二个同名标记读成
   * 回边。resume 时脚本重跑会把前缀再发一遍（没有 journal 行可去重），消费者单调归约即免疫。
   */
  | { type: "phase-entered"; name: string; ordinal: number }
  /**
   * 脚本到达一处未补全的留白（docs/execution-engine.md「Holes」）。`instance` 是
   * `<留白 id>@ordinal`——序号与节点同族铸造，但**没有 journal 行**；`phaseName` 是出生阶段，
   * 与 `node-queued` 同一张表打戳。`prompt` 已截到 4000 字符。resume 后一个仍在等的留白会被
   * 脚本重新到达、再记一条（没有行、没有序号可撞）。
   */
  | {
      type: "hole-reached";
      instance: InstanceRef;
      name: string;
      prompt?: string;
      phaseName?: string;
    }
  /**
   * `fillHole`：有效脚本已写回 run 行、停驻的分支已放行。`phaseNames` 是有效脚本的阶段表
   * （留白按名字占位），`holes` 是其中仍未补全的留白下标（与 `run-launched.holes` 同规对齐），
   * 侧栏据此重画站点而不必等展示载荷；`filledBy` 是补全它的会话。
   */
  | {
      type: "hole-filled";
      siteId: string;
      filledAt: number;
      filledBy?: string;
      phaseNames: string[];
      holes?: number[];
      /**
       * 这次补全给一个原本没有草稿的 run 铸下的草稿（docs/dynamic-workflow/launch.md「The draft
       * after a fill」）。`run-launched.scriptPath` 只在建 run 那一世写一次，冷读面若只看它，重启后
       * 就找不到补全铸的那份——所以后铸的路径随这条事件落 journal，冷读取最后一条在场的。
       * 原本就有草稿的补全（就地改写、路径不变）不带它。
       */
      scriptPath?: string;
    }
  /**
   * 一条被发布的中间结果，每个**未被跳过**的 report 调用恰好一次（replay 命中即静默跳过，
   * 不重发）。走与其他 run 事件完全相同的路线（进度汇 → 有界会话事件 → 投影 reducer），
   * 终点是 run 面板的 Results 区。
   *
   * `artifactId` 在场即这条 item 同时喂给了那个预置产物（`report(item, "perf")`）——投影据它
   * 给该产物的 `itemCount` 加一，看板 hook 以计数变化为增量取数的信号。
   */
  | { type: "report"; instance: InstanceRef; item: unknown; artifactId?: string }
  /**
   * 一个**用户面产物**的新版本已就位：内容成员每成功发布一次一条，预置成员每次真正落下
   * 声明（幂等 no-op 不发）一条。与 report 同规——replay 命中不重发，冷恢复从 journal 读。
   *
   * 成功路径**只发这一条**，不发任何节点生命周期事件（node-queued / dispatched / settled）。
   * 与 `report` 同一条论证：产物是交付物，不是别人能等的一步，它在两张图里都不是节点。
   */
  | { type: "artifact-published"; instance: InstanceRef; artifact: ArtifactVersionRecord }
  /**
   * 一次内容产物发布失败（节点以 `failed` 落 journal，脚本那侧拿到一个可 catch 的拒绝）。
   *
   * **刻意不复用 `node-settled{failed}`**：那个事件的读者会把它归约进 `nodes[]` 并要求站点在
   * 图里有对应的节点，而产物站点**不进任何图**——一条 node-settled 落在这样的站点上，在 run
   * 面板里就是一个无从解释的「未知节点」，图层还会报告一个不认识的 site id。发布的失败因此
   * 需要自己的事件：它带着足以渲染一张失败卡的东西（id / 种类 / 结构化错误），而不冒充一步
   * 工作。replay 命中一条失败记录时**不重发**（同 report / artifact-published）。
   */
  | {
      type: "artifact-failed";
      instance: InstanceRef;
      id: string;
      op: ArtifactContentOp;
      error: WorkflowErrorJson;
    }
  | { type: "compaction"; actor: ActorRef }
  /**
   * 一个 actor 把阻塞问题升级给了主代理，并停驻在自己那次 ask 里等答案。
   *
   * **引擎核心从不发这两个事件**——它们由 driver 在执行 ask 的边界内发出（与 repair /
   * nudge 轮次同层），零 I/O 状态机不感知升级。之所以仍然住在这份词汇表里：它们走的是与
   * 其他 run 事件完全相同的两条轨（journal 的 dwf_event + driver.emit 的实时扇出），而那两条
   * 轨的形状由 `RunEvent` 定义。升级**不写 dwf_node 行**（等待不是工作量）。
   */
  | {
      type: "escalation-raised";
      qid: string;
      actor: ActorRef;
      /**
       * actor 的**有效名**（= `normalizePersona` 后的 `spec.name`，也就是 `actor-created`
       * 事件上那一个、以及 amend-resume 用作缓存身份键的那一个）。匿名 actor 缺席，
       * 且不合成兜底标签——消费者各自决定怎么渲染「无名」。
       */
      actorName?: string;
      question: string;
      context?: string;
      /**
       * 提问时刻（epoch 毫秒）。**必填**：读者要回答的第一个问题恒是「这个问题已经等了多久」，
       * 而事件轨上没有别的时钟可用——`dwf_event.time_created` 只在 durable 那一轨上有，实时轨
       * （driver.emit → progress sink → 侧栏）拿不到它，让 UI 用「收到事件的本地时刻」兜底就会
       * 在冷启动重放整段历史时把每个问题都显示成刚刚提的。
       *
       * 与快照 `pendingQuestions[].askedAt` **同一个瞬间**（driver 只取一次 `Date.now()`，
       * 事件与停驻记录共用），所以两条读面上的等待时长永远一致。
       */
      askedAt: number;
    }
  | { type: "escalation-resolved"; qid: string; answer: string }
  /** run 级停滞观察（见 {@link RunStallInfo}）；run 结算后到达的调用被忽略。 */
  | ({ type: "run-stalled" } & RunStallInfo)
  /**
   * `stopReason` 只在 `status === "stopped"` 时在场；`error` 在 `errored` 恒在场，在
   * `stopped` 只对 `provider`（`ProviderStop`）与 `interrupted`（`Interrupted`）在场。
   */
  | {
      type: "run-settled";
      status: RunStatus;
      stopReason?: RunStopReason;
      /** `stopReason === "superseded"` 时在场：停下本 run 的那次修订铸出的新 run。 */
      supersededBy?: string;
      error?: WorkflowErrorJson;
    };
