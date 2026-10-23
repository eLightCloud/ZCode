import type * as implementation1 from "./projection-action-targets.js";
import type { ProductProjectionApi } from "./projection-api.js";
import type * as implementation15 from "./projection-background-events.js";
import type * as implementation17 from "./projection-compact-events.js";
import type * as implementation0 from "./projection-configuration.js";
import type { ProductProjectionContext } from "./projection-context.js";
import type * as implementation19 from "./projection-control-state.js";
import { adoptProjectionState, cloneProjectionState } from "./projection-copy.js";
import type * as implementation2 from "./projection-event-commit.js";
import type * as implementation3 from "./projection-event-dispatch.js";
import type * as implementation18 from "./projection-goal-events.js";
import type * as implementation4 from "./projection-hook-events.js";
import { installProductProjectionMethods } from "./projection-methods.js";
import type * as implementation16 from "./projection-model-completion.js";
import type * as implementation7 from "./projection-model-stream.js";
import type * as implementation8 from "./projection-network-status.js";
import type * as implementation11 from "./projection-permission-events.js";
import type * as implementation12 from "./projection-queue-events.js";
import type * as implementation13 from "./projection-queue-state.js";
import type * as implementation21 from "./projection-row-index.js";
import type * as implementation14 from "./projection-subagent-events.js";
import type * as implementation10 from "./projection-tool-results.js";
import type * as implementation9 from "./projection-tool-stream.js";
import type * as implementation6 from "./projection-turn-end.js";
import type * as implementation5 from "./projection-turn-start.js";
import type * as implementation20 from "./projection-turn-timing.js";

// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）

import type {
  ConversationSnapshot,
  CuaAppIdentity,
  MutableConversationSnapshotAccumulator,
} from "@zcode/shared/zcode-protocol-v4";

import { type ConversationNormalizationDiagnostic } from "./event-normalizer.js";

import { createInitialConversationSnapshot } from "./projection-state.js";

import type {
  ContextWindowProjectionState,
  ConversationEditTarget,
  FileToolInputPreviewState,
  HighspeedToolInterval,
  PendingSessionHookInvocation,
  TurnModelBaseline,
} from "./product-projection-contract.js";

export type {
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
  SessionConfigSeed,
  SessionSubagentsSeed,
  SessionUsageSeed,
  StableForkCandidate,
  StableForkCandidateResolution,
} from "./product-projection-contract.js";

export class ProductProjection {
  // 类型声明无实例字段；实现由下方唯一安装器登记在同一 owner 原型。
  declare seedConfig: ProductProjectionApi["seedConfig"];
  declare seedSharedContextImport: ProductProjectionApi["seedSharedContextImport"];
  declare seedUsage: ProductProjectionApi["seedUsage"];
  declare seedSubagents: ProductProjectionApi["seedSubagents"];
  declare resolveEditTarget: ProductProjectionApi["resolveEditTarget"];
  declare resolveEditTargetByEntityId: ProductProjectionApi["resolveEditTargetByEntityId"];
  declare resolveRowActionTarget: ProductProjectionApi["resolveRowActionTarget"];
  declare getMessageIdsForTurnRow: ProductProjectionApi["getMessageIdsForTurnRow"];
  declare isLatestAssistantSegmentRow: ProductProjectionApi["isLatestAssistantSegmentRow"];
  declare resolveStableForkCandidate: ProductProjectionApi["resolveStableForkCandidate"];
  declare isLatestRetryAssistantRow: ProductProjectionApi["isLatestRetryAssistantRow"];
  declare isLatestEditableUserRow: ProductProjectionApi["isLatestEditableUserRow"];
  declare getTurnIdForRow: ProductProjectionApi["getTurnIdForRow"];
  declare getTurnRewindAnchor: ProductProjectionApi["getTurnRewindAnchor"];
  declare applyEvent: ProductProjectionApi["applyEvent"];
  declare beginHydrationReplay: ProductProjectionApi["beginHydrationReplay"];
  declare applyHydrationEvent: ProductProjectionApi["applyHydrationEvent"];
  declare completeHydrationReplay: ProductProjectionApi["completeHydrationReplay"];
  declare establishedStreamingAppend: ProductProjectionApi["establishedStreamingAppend"];

  private snapshot: ConversationSnapshot;
  // reducer 内部的 rowId 查找必须与 rows.window 同步；冷恢复过去每次 find 都扫描全表，
  // tool/turn 终态越多退化越明显。普通归约增量维护，rewind 才重建。
  private rowIndexById = new Map<number, number>();
  private hydrationAccumulator: MutableConversationSnapshotAccumulator | null = null;
  private nextRowId = 1;
  private streamingTextRowId: number | null = null;
  private streamingReasoningRowId: number | null = null;
  // output-token Continue 是同一 product turn 内的请求级恢复，不应泄漏成新的正文行。
  // 这里只保留上一条满足 length/zero-tool/视觉紧邻条件的 text row，任何真实边界都会清空。
  private outputContinuationTextRowId: number | null = null;
  private toolRowIdByCallId = new Map<string, number>();
  private latestListAppsSnapshot = new Map<number, CuaAppIdentity>();
  // snapshot 是权威状态；该 Set 只是 TurnComplete 缺终态兜底的派生索引，避免每轮扫描全表。
  private openForegroundToolCallIds = new Set<string>();
  private fileToolInputPreviewByCallId = new Map<string, FileToolInputPreviewState>();
  private subagentRowIdByAgentId = new Map<string, number>();
  private hookRowIdByInvocationId = new Map<string, number>();
  // resume SessionStart 没有 turnId；先保留在 CLI projection，下一条真实 user-intent
  // TurnStarted 到达后再分配 rowId/turnId。不得构造 session-hooks:* synthetic turn。
  private pendingSessionHookInvocations = new Map<string, PendingSessionHookInvocation>();
  // rewind 后 async Hook 的 terminal 仍可能迟到；保留 invocation 墓碑，避免被删旧分支
  // 因找不到原 row 而被 terminal-only 兼容路径重新 append。
  private rewoundHookInvocationIds = new Set<string>();
  // 冷恢复 transcript 可能含旧版本先发布、后持久化失败的 ghost child。store seed 后
  // 必须持续排除，而不是只覆盖一次 snapshot；否则下一条无关事件会从历史 row 再物化它。
  private invalidSubagentChildSessionIds = new Set<string>();
  // rowId → 权威 messageId 侧表。forkAssistant/editUserQuery 的命令载荷用 rowId
  // 定位，但旧 fork/rewind operations 用 messageId（history target）——桥接层经本表翻译。
  // 不进 row schema（客户端只发 rowId，messageId 是服务端内部锚点，避免污染冻结的行结构）。
  private messageIdByRowId = new Map<number, string>();
  // Continue 复用 rowId 后，动作锚点推进到最后一条 assistant message；旧 partial messageId
  // 仍需能命中同一 row，供 compact coverage、rewind 和整轮文件事实恢复使用。
  private outputContinuationRowIdByMessageId = new Map<string, number>();
  private entityIdByRowId = new Map<number, string>();
  // canonical command target 只按稳定实体身份寻址；rowId 仅是本次 materialization 的
  // transient lookup，刷新/replay 后变化也不会改变 target identity。
  private editTargetByEntityId = new Map<string, ConversationEditTarget>();
  private currentEditableEntityId: string | null = null;
  private stableCompactCoverageBoundaryRowId: number | null = null;
  private turnHeaderRowIdByTurnId = new Map<string, number>();
  private compactMarkerRowIdByOperationId = new Map<string, number>();
  // goal verify boundary 身份 = targetId_goalIteration
  // （verificationId 仅 attempt alias——同 iteration 重试携带新 verificationId，
  // 旧实现按 verificationId keying 会长出第二个 marker）。
  private goalVerifyMarkerRowIdByLifecycleKey = new Map<string, number>();
  // queue drain 在同一 runtimeTurn 内切出新的
  // product turn。runtimeTurnId → 当前 productTurnId 映射；后续事件行经 turnIdOf
  // 归入最新 productTurn。steer（guide）不切轮，内联当前轮。
  private productTurnIdByRuntimeTurnId = new Map<string, string>();
  private runtimeTurnIdByProductTurnId = new Map<string, string>();
  private productTurnSplitOrdinalByRuntimeTurnId = new Map<string, number>();
  private currentProductTurnStartedAtMs: number | null = null;
  // Highspeed 分享需要的真实耗时由 CLI 事件聚合，避免 renderer 离场后丢失拆分数据。
  private highspeedModelDurationByTurnId = new Map<string, number>();
  private highspeedToolIntervalsByTurnId = new Map<string, Map<string, HighspeedToolInterval>>();
  // 投递语义侧表：TurnSteerQueued 时按事件 payload（或 followupMode 兜底）记录，
  // drain 时决定切轮 vs 内联；账本落地后以账本为准。
  private deliveryByPendingInputId = new Map<string, "guide" | "queue">();
  private currentTurnId: string | null = null;
  // 当前 runtime turn 是否由 model-only TurnStarted 建立（manual /compact、
  // goal continuation 等维护 turn）。SessionStart 摘要的 pending 归位不得以维护
  // turn 为收口目标，必须等下一条 user-visible 真实 turn。
  private currentTurnStartedModelOnly = false;
  // contextWindow=null 时协议不暴露分母与已用量，但 reducer 仍需保留最新 context 用量，
  // 以便 registry 后续恢复已知容量时原子重建 usage，而不是错误归零。
  private contextWindowState: ContextWindowProjectionState = {
    maxTokens: null,
    touchedByEvent: false,
    usedTokens: 0,
  };
  // modelChange marker 在「下一个 turn 开始时」生成。
  // silentInitial 保持普通 Main 首轮静默；sourceLess 表示显式 ∅→X；known 保存上一轮
  // 实际使用的 provider/model。thought 只随基线记录，不触发模型身份变化。
  private lastTurnModel: TurnModelBaseline = { kind: "silentInitial" };
  // 种子守卫：事件（权威日志）触碰过的 config 区块不再接受种子覆盖。
  private configModelTouchedByEvent = false;
  // 旧 ModelSelected 不含能力集合；独立守卫允许 runtime seed 补齐旧日志，
  // 又避免后续种子覆盖新事件已原子发布的模型能力。
  private configThoughtLevelsTouchedByEvent = false;
  private configModeTouchedByEvent = false;
  // assistant 守恒：非运行期拒收的正文流计数（gateway 据此置 stale）。
  private droppedContentStreamEventCount = 0;
  // 读取期 legacy fallback 必须可观测；否则 normalizer 缺字段后仍会退化为“可见但不可寻址”。
  private normalizationDiagnostics: ConversationNormalizationDiagnostic[] = [];

  constructor(sessionId: string, logEpoch: string) {
    this.snapshot = createInitialConversationSnapshot(sessionId, logEpoch);
  }

  getSnapshot(): ConversationSnapshot {
    return this.snapshot;
  }

  /** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段，需重 hydration）。 */
  getDroppedContentStreamEventCount(): number {
    return this.droppedContentStreamEventCount;
  }

  getNormalizationDiagnostics(): readonly ConversationNormalizationDiagnostic[] {
    return this.normalizationDiagnostics;
  }

  /** 仅供 publisher 的有界增量估算；返回 null 表示必须走候选快照精确校验。 */

  /**
   * config 种子注入。
   *
   * 初始快照 config 曾写死空 provider/model +
   * mode="build"，而 ModelSelected 只在 switchModelConfig 后补发、SessionCreated 刻意
   * 不产 delta——runtime 真值（启动默认模型/项目持久化 mode/历史会话上次选型）从头到尾
   * 进不了投影。后果：① 新会话模型选择器显示空；② 项目持久化 mode=yolo 时 UI 显示
   * build，点 yolo 命中 handler 同值 no-op（判的是 runtime 真值），UI 永远无法收敛——
   * 打破了「revision 不变 ⇔ 无状态变化」的 CAS 不变量。
   *
   * 为什么这么修：种子直改 snapshot.config，不产 delta、不递增 revision/seq——
   * draft「无可见 delta」裁决不被破坏；事件触碰过的区块跳过（重放序
   * 在种子之后时日志值优先）。幂等：可在 ensurePublisher / hydration 后重复调用。
   */

  /**
   * 导入分享上下文的来源只读种子。
   *
   * shared_context 是 provider-only message，不应物化为用户气泡；来源标记通过
   * snapshot additive 字段下发，供 Desktop 在打开新会话后显示持久提示。该字段
   * 不属于 conversation rows，也不递增 revision/seq，避免伪造一轮对话。
   */

  /**
   * 冷恢复的 subagent store 校验种子。transcript 可以恢复可见 row，但只有 session
   * store 能证明 child 已持久化为 subagent_child；因此在 candidate publisher 发布前
   * 用该种子整体替换 manifest，旧版本遗留的幽灵 child 不得进入 UI 权威态。
   */

  /**
   * rowId → 权威 messageId。桥接层执行 forkAssistant/editUserQuery 时把命令载荷的
   * 内部 rowId 翻译成 core 需要的 messageId。未知 rowId（非 assistant/user 行、
   * 或迟到）返回 null，桥接层据此回 rejected。
   */
  getMessageIdForRow(rowId: number): string | null {
    return this.messageIdByRowId.get(rowId) ?? null;
  }

  getEntityIdForRow(rowId: number): string | null {
    return this.entityIdByRowId.get(rowId) ?? null;
  }

  /**
   * V3 行动作的唯一解析器。展示 rowId 与稳定 entityId 必须同时命中当前 projection；
   * action 可用性直接读取同一次 materialization 生成的 row.actions，handler/preview
   * 不得再各自按位置、phase 或文本重算。
   */

  /**
   * 文件摘要撤销以 turn rowId 为入口，服务端解析同一 product turn 内所有
   * messageId，覆盖多段 assistant / 多个 checkpoint；UI 不暴露内部 messageId。
   */

  /**
   * core 侧强校验：
   * rowId 是否为其所属 productTurn 的最后一段 assistantText。UI（平铺后）已只在
   * 最后段暴露 fork 入口，这里是防御闸——直接命令面/旧客户端不得 fork 中间段。
   */

  /**
   * running fork 的同步投影闸门：这里只解析 row/product-turn 与 message 边界；完整
   * orderedMessageIds 由 host 再用 session store 权威顺序补齐并持久化 anchor。
   */

  /** latestAssistantRetryOnly：retry 只能指向全时间线最新且有 realUser cause 的 assistantText。 */

  /** latestQueryEditOnly：只有当前投影里的最后一条 realUser userInput row 可 edit。 */

  /** rowId → product turnId（命令层 running edit 在无 assistant anchor 时回查 store 用）。 */

  /** 应用一个权威事件，返回该事件产生的 delta 序列（可能为空）。 */

  /**
   * 冷恢复批量路径只允许在尚未发布的候选 projection 上使用。begin 后 rows.window
   * 原地推进，避免每个事件复制增长数组；publisher 在完整校验通过前不会 adopt 候选。
   */

  /**
   * 把批量期间延迟的 command actions 收敛到当前快照。actions 是同一 reducer 的派生
   * materialization，不单独递增 revision；触发它变化的结构/guard 事件已经记账。
   */

  declare private applyEventInternal: OmitThisParameter<typeof implementation2.applyEventInternal>;

  /**
   * 在独立候选投影上归约事件，校验通过后才原子提交。
   *
   * projection 超过 logical frame assembly 上限时，如果先修改当前实例再等
   * wire encoder 报错，权威内存态会永久停在“无法发 snapshot”的状态。候选实例同时
   * 隔离 snapshot 与 reducer 的各类 side-map；拒绝时当前实例完全不变，客户端仍可从
   * 最后一个可传输 snapshot 恢复。
   *
   * `accept` 同时拿到这条事件**实际产出**的 delta：有些事件类别可以只按 delta 的字节数给出
   * 一个可靠上界，不必把整份候选快照再序列化一遍（publisher 的 ingest 快路径）。传的是实际
   * 产出而不是预演，正是因为预演算不准——投影在 reducer 之上还叠了 subagent 镜像与命令
   * actions 的 materialization，少算一条就把 16MiB 闸门算松了。
   */
  declare applyEventAtomically: OmitThisParameter<typeof implementation2.applyEventAtomically>;

  private cloneProjection(): ProductProjection {
    return cloneProjectionState.call(
      this as unknown as ProductProjectionContext,
      ProductProjection.prototype,
    );
  }

  private adoptProjection(candidate: ProductProjection): void {
    adoptProjectionState.call(
      this as unknown as ProductProjectionContext,
      candidate as unknown as ProductProjectionContext,
    );
  }

  /**
   * 基于本事件归约后的 prospective rows 原子生成 edit/retry actions。
   * action=true 必须蕴含命令层同 revision 下能解析出持久 message target；最新目标
   * 改变时同时 upsert 旧、新两行，客户端不需要按数组位置补推断。
   */
  declare private materializeCommandRowActions: OmitThisParameter<
    typeof implementation2.materializeCommandRowActions
  >;

  // revision 递进：本事件含任一结构性 delta → revision +1，
  // 且携带规则要求 deltas 中必含 state.updated.revision。
  declare private attachRevision: OmitThisParameter<typeof implementation2.attachRevision>;

  declare private reduce: OmitThisParameter<typeof implementation3.reduce>;

  /** A persisted started-only Hook cannot still be running after a real runtime resume. */
  declare private onSessionResumed: OmitThisParameter<typeof implementation3.onSessionResumed>;

  declare private onHookRunLifecycle: OmitThisParameter<typeof implementation4.onHookRunLifecycle>;

  /**
   * UserPromptSubmit 的 executed block 是当前输入的可见错误，但不是 task 失败。
   * 将它投影到 transient lastError，让 ChatErrorBanner 直接展示原因；下一轮 TurnStarted
   * 会按既有生命周期清理它。admission-only block 和工具边界 block 仍只保留在 Hook 摘要。
   */
  declare private hookBlockErrorDelta: OmitThisParameter<
    typeof implementation4.hookBlockErrorDelta
  >;

  declare private flushPendingSessionHookInvocations: OmitThisParameter<
    typeof implementation4.flushPendingSessionHookInvocations
  >;

  declare private hookExecutionState: OmitThisParameter<typeof implementation4.hookExecutionState>;

  declare private hookExecutionOutcome: OmitThisParameter<
    typeof implementation4.hookExecutionOutcome
  >;

  declare private hookInvocationState: OmitThisParameter<
    typeof implementation4.hookInvocationState
  >;

  declare private hookInvocationLane: OmitThisParameter<typeof implementation4.hookInvocationLane>;

  /**
   * rewind/edit/retry 的 live 投影截断（editUserQuery/retryTurn 的
   * `row.removed(target 起)`）。RewindTriggered 带 targetMessageId → 反查 rowId →
   * 从该行所属 turn 的首行（turnHeader）起整段移除，让 live 订阅者即时看到截断，
   * 后续 editRerun 新 turn 走既有事件路径追加。冷订阅/刷新的 truncated transcript
   * 由 transcript 合成 hydration 兜底重建。
   * messageId 反查不到（user 行暂无 messageId、或迟到）时返回空，不误删。
   */
  declare private onRewindTriggered: OmitThisParameter<typeof implementation17.onRewindTriggered>;

  /** messageId → rowId 反查（messageIdByRowId 的逆向线性扫描；行数有界，无需额外索引）。 */
  declare private rowIdForMessageId: OmitThisParameter<typeof implementation5.rowIdForMessageId>;

  /**
   * 任意 rowId → 其所属 turn 的 rewind 锚点 messageId。新 live/cold user row 都应
   * 直接携持久 user messageId；同 turn assistant 只保留为旧事件兼容 fallback。
   * `canEdit` 不允许依赖该 fallback，必须由 user row 自身的 exact target 驱动。
   */

  declare private rewindAnchorForRows: OmitThisParameter<
    typeof implementation5.rewindAnchorForRows
  >;

  /**
   * real-user row 的展示身份与命令身份必须原子登记。
   * TurnSteerDrained 曾只写 messageId/entityId，漏写 edit target，
   * 导致 UI action 与 editUserQuery resolver 对同一行得出相反结论。
   */
  declare private registerCanonicalUserRowTarget: OmitThisParameter<
    typeof implementation1.registerCanonicalUserRowTarget
  >;

  // ── 生命周期 ──

  declare private onSessionCreated: OmitThisParameter<typeof implementation0.onSessionCreated>;

  // renameSession / 自动标题：SessionTitleUpdated(title, source) → 更新 meta。
  // custom（用户重命名）优先级最高，已 custom 后不再被 generated 覆盖（与 core titleSource 一致）。
  declare private onSessionTitleUpdated: OmitThisParameter<
    typeof implementation0.onSessionTitleUpdated
  >;

  declare private onTurnStarted: OmitThisParameter<typeof implementation5.onTurnStarted>;

  declare private applyBackgroundTaskNotification: OmitThisParameter<
    typeof implementation5.applyBackgroundTaskNotification
  >;

  declare private onTurnComplete: OmitThisParameter<typeof implementation6.onTurnComplete>;

  /**
   * draft 只有一种离场方式：第一轮收口。phase `draft` 的定义是「纯内存、从未有过真实内容、CLI 重启即
   * 消失」；一条 controlOnly 轮一旦收口，会话已有一段持久化的可见历史，再叫 draft 就与
   * 冷恢复矛盾——store 种子会给它一个终态 phase，而活投影却停在 draft。中枢直接启动
   * 的会话只有一条 controlOnly 启动轮，活投影 phase 恒为 draft，sessions-index 摘要因此被 task-index
   * syncer 当 draft 丢弃，侧栏要等重启才出现。所以 controlOnly 收口只在**会话仍是 draft**时推进 phase
   * （成功 → completedSuccess，取消 → completedInterrupted，失败 → error）；非 draft 会话上的控制轮
   * 照旧不碰 session control（goal 的可见 query 轮不得伪造 running / 工时，见 onTurnStarted）。
   */
  declare private leaveDraftAfterControlOnlyTurn: OmitThisParameter<
    typeof implementation6.leaveDraftAfterControlOnlyTurn
  >;

  declare private onTurnError: OmitThisParameter<typeof implementation6.onTurnError>;

  // ── 流式输出 ──

  declare private onModelNetworkStatus: OmitThisParameter<
    typeof implementation8.onModelNetworkStatus
  >;

  declare private onStreamRecoveryStarted: OmitThisParameter<
    typeof implementation8.onStreamRecoveryStarted
  >;

  declare private onStreamRecoveryTailDiscarded: OmitThisParameter<
    typeof implementation8.onStreamRecoveryTailDiscarded
  >;

  declare private onStreamRecoveryRetryStarted: OmitThisParameter<
    typeof implementation8.onStreamRecoveryRetryStarted
  >;

  declare private streamRecoveryApiRetry: OmitThisParameter<
    typeof implementation8.streamRecoveryApiRetry
  >;

  declare private setApiRetry: OmitThisParameter<typeof implementation8.setApiRetry>;

  declare private acceptsActiveModelEvent: OmitThisParameter<
    typeof implementation7.acceptsActiveModelEvent
  >;

  declare private onModelStreaming: OmitThisParameter<typeof implementation7.onModelStreaming>;

  declare private openTextRow: OmitThisParameter<typeof implementation7.openTextRow>;

  declare private closeTextRow: OmitThisParameter<typeof implementation7.closeTextRow>;

  declare private onAssistantFeedbackUpdated: OmitThisParameter<
    typeof implementation10.onAssistantFeedbackUpdated
  >;

  declare private onHighspeedMetricsUpdated: OmitThisParameter<
    typeof implementation10.onHighspeedMetricsUpdated
  >;

  declare private onTurnExecutionModelFallback: OmitThisParameter<
    typeof implementation16.onTurnExecutionModelFallback
  >;

  declare private openReasoningRow: OmitThisParameter<typeof implementation7.openReasoningRow>;

  declare private closeReasoningRow: OmitThisParameter<typeof implementation7.closeReasoningRow>;

  declare private closeStreamingRows: OmitThisParameter<typeof implementation7.closeStreamingRows>;

  // turn 终态收口所有 foreground 未终态 tool row（迟到终态不复活由 isRunning 闸保证）；
  // `only` 让 stream recovery 只收口未定稿的那一部分。
  declare private closeOpenToolRows: OmitThisParameter<typeof implementation6.closeOpenToolRows>;

  declare private isOpenForegroundToolRow: OmitThisParameter<
    typeof implementation6.isOpenForegroundToolRow
  >;

  declare private updateToolIndexesAfterDeltas: OmitThisParameter<
    typeof implementation9.updateToolIndexesAfterDeltas
  >;

  declare private pruneRemovedSubagentIndexes: OmitThisParameter<
    typeof implementation9.pruneRemovedSubagentIndexes
  >;

  // ── tool call 状态机 ──

  declare private openToolRow: OmitThisParameter<typeof implementation9.openToolRow>;

  declare private appendStreamingToolInput: OmitThisParameter<
    typeof implementation9.appendStreamingToolInput
  >;

  declare private flushStreamingToolInput: OmitThisParameter<
    typeof implementation9.flushStreamingToolInput
  >;

  declare private takePendingStreamingToolInput: OmitThisParameter<
    typeof implementation9.takePendingStreamingToolInput
  >;

  declare private finalizeStreamingToolInput: OmitThisParameter<
    typeof implementation9.finalizeStreamingToolInput
  >;

  declare private onToolCallScheduled: OmitThisParameter<
    typeof implementation9.onToolCallScheduled
  >;

  declare private onToolCallActivity: OmitThisParameter<typeof implementation9.onToolCallActivity>;

  /**
   * MCP `notifications/progress`（A8）→ 行上的 progress。只在 running 时写：
   * 终态之后迟到的进度通知不能把 success/error 行重新点亮；bash 的 stdout 字节进度不在这里消费。
   */
  declare private onToolCallProgress: OmitThisParameter<typeof implementation9.onToolCallProgress>;

  declare private onToolCallResult: OmitThisParameter<typeof implementation10.onToolCallResult>;

  /**
   * TodoWrite 同时投影 live plan 与当前 goal iteration。
   * V4 之前只保留 tool row，右上角摘要无法在 live/cold 恢复后重建每轮 action/status。
   * 轮次只由 verifier boundary 推进；TodoWrite 只更新当前打开轮次，不能自行加一轮。
   */
  declare private todoPlanDeltas: OmitThisParameter<typeof implementation10.todoPlanDeltas>;

  declare private onToolCallError: OmitThisParameter<typeof implementation10.onToolCallError>;

  // ── 权限交互（阻塞交互 → 状态）──

  declare private onPermissionRequested: OmitThisParameter<
    typeof implementation11.onPermissionRequested
  >;

  declare private createPendingInteractionFromPermissionEvent: OmitThisParameter<
    typeof implementation11.createPendingInteractionFromPermissionEvent
  >;

  declare private onPermissionResolved: OmitThisParameter<
    typeof implementation11.onPermissionResolved
  >;

  declare private onPermissionDenied: OmitThisParameter<typeof implementation11.onPermissionDenied>;

  declare private onWorkspaceHookReviewRequested: OmitThisParameter<
    typeof implementation4.onWorkspaceHookReviewRequested
  >;

  declare private onWorkspaceHookReviewSettled: OmitThisParameter<
    typeof implementation4.onWorkspaceHookReviewSettled
  >;

  declare private onWorkspaceHookReviewSuperseded: OmitThisParameter<
    typeof implementation4.onWorkspaceHookReviewSuperseded
  >;

  declare private removeWorkspaceHookReview: OmitThisParameter<
    typeof implementation4.removeWorkspaceHookReview
  >;

  /**
   * 软门禁:处理 WorkspaceHookAdmissionUpdated 事件。
   *
   * pendingCount > 0 → 写入 snapshot.workspaceHookAdmission(提示条出现);
   * pendingCount === 0 → 置 null(提示条消失)。
   */
  declare private onWorkspaceHookAdmissionUpdated: OmitThisParameter<
    typeof implementation4.onWorkspaceHookAdmissionUpdated
  >;

  declare private onUserInputAutoResolutionUpdated: OmitThisParameter<
    typeof implementation11.onUserInputAutoResolutionUpdated
  >;

  declare private settlePermission: OmitThisParameter<typeof implementation11.settlePermission>;

  // ── turn-steer 队列──

  declare private onTurnSteerQueued: OmitThisParameter<typeof implementation12.onTurnSteerQueued>;

  declare private onTurnSteerDispatchChanged: OmitThisParameter<
    typeof implementation12.onTurnSteerDispatchChanged
  >;

  declare private onTurnSteerDeliveryChanged: OmitThisParameter<
    typeof implementation12.onTurnSteerDeliveryChanged
  >;

  declare private onTurnSteerDrained: OmitThisParameter<typeof implementation12.onTurnSteerDrained>;

  /**
   * queue drain 边界 = product turn 边界（同一 runtimeTurn 内）。
   * 收口上一段 productTurn 的 header（工时按边界拆分，加和 = 总工时），
   * 映射 runtimeTurnId → 新 productTurnId，开新 turnHeader。
   */
  declare private splitProductTurn: OmitThisParameter<typeof implementation20.splitProductTurn>;

  // 工时按边界拆分：drain 切过轮的 runtimeTurn，最后一段 productTurn 的工时
  // = 最后一次边界到完成，不再用整段 runtime duration（否则两段加和超真实时长）。
  declare private activeMsForCompletion: OmitThisParameter<
    typeof implementation20.activeMsForCompletion
  >;

  declare private onTurnSteerDiscarded: OmitThisParameter<
    typeof implementation13.onTurnSteerDiscarded
  >;

  declare private onSessionInputPromoted: OmitThisParameter<
    typeof implementation13.onSessionInputPromoted
  >;

  /** v4 queue 重排：按 orderedPendingInputIds 重排 queue rows（未列出的项保持相对顺序追加）。 */
  declare private onTurnSteerReordered: OmitThisParameter<
    typeof implementation13.onTurnSteerReordered
  >;

  // setAutoDrain：queue.autoDrain 授权位翻转。autoDrain 影响 held 派生
  // （heldQueueInputRequiresChoice）与 A 区可用性 → 走 queuePatch 统一重算。
  declare private onQueueAutoDrainChanged: OmitThisParameter<
    typeof implementation13.onQueueAutoDrainChanged
  >;

  // setFollowupMode：config.followupMode 翻转。followupMode 是 running 时
  // enqueue vs guide 的路由授权位（computeInputRouting）→ 改 config 后同步重算 A 区。
  declare private onFollowupModeChanged: OmitThisParameter<
    typeof implementation13.onFollowupModeChanged
  >;

  /**
   * switchCollaborationMode：SessionModeChanged → config.mode。
   * 事件来源覆盖命令面（source=command）与 plan 工具路径（enterPlanMode/exitPlanMode，
   * source=tool）——两条路径共用这条投影，UI 的模式选择器因此也能跟随工具驱动的模式切换。
   */
  declare private onSessionModeChanged: OmitThisParameter<
    typeof implementation0.onSessionModeChanged
  >;

  /**
   * Subagent row 与摘要投影在同一个 event transaction 内 materialize。
   * 旧 UI 在 spawn 后另查 session/subagents；7 个并发 child 中查询若恰好落在
   * 最后一个 session 持久化前，就会永久缓存 6，直到切换 Session 才重查。现在 renderer
   * 只消费这里随 row 一起提交的完整态，不再存在事件/查询双时钟。
   */
  declare private shouldMaterializeSubagentProjection: OmitThisParameter<
    typeof implementation14.shouldMaterializeSubagentProjection
  >;

  declare private materializeSubagentProjection: OmitThisParameter<
    typeof implementation14.materializeSubagentProjection
  >;

  declare private prospectiveSubagentRow: OmitThisParameter<
    typeof implementation14.prospectiveSubagentRow
  >;

  // ── subagent 行镜像──
  // schema/UI 已有 subagent row，但旧 reducer 未消费 Subagent* 事件；
  // cold hydration 即使合成事件也无法恢复下钻行。这里让 live/cold 共用同一状态机。

  declare private onSubagentSpawned: OmitThisParameter<typeof implementation14.onSubagentSpawned>;

  declare private resumedSubagentBackgroundWorkDelta: OmitThisParameter<
    typeof implementation15.resumedSubagentBackgroundWorkDelta
  >;

  declare private onSubagentMessage: OmitThisParameter<typeof implementation15.onSubagentMessage>;

  declare private onSubagentStopped: OmitThisParameter<typeof implementation15.onSubagentStopped>;

  // cancelBackgroundWork：后台任务生命周期（BackgroundTaskStarted/Updated/Completed）
  // → 维护 snapshot.backgroundWorks（后台工作面读它渲染 + cancel 入口）。
  // taskId≡workId 无需翻译；status 归一到 summary 的 4 值封闭枚举。
  declare private onBackgroundTaskLifecycle: OmitThisParameter<
    typeof implementation15.onBackgroundTaskLifecycle
  >;

  // ── dwf 实时运行态：DynamicWorkflowRunProgress → workflowRuns 状态键 ──
  // 一条引擎 RunEvent 一条会话事件，归约成键级整体替换的权威态。走 reducer 而不是侧通道，
  // 所以持久、可回放、冷恢复免费（先例：subagents 键）。
  //
  // 归约本体在 @zcode/shared 的 workflow-runs-reducer（与状态 schema 同居）：TUI 镜像要用
  // 同一份归约，两处各写一份就是两个时钟（docs/dynamic-workflow/launch.md「The inline card」）。
  // 留在这里的只有投影的非纯部分——从事件信封取载荷、把新旧状态之差发成键级增量。
  declare private onDynamicWorkflowRunProgress: OmitThisParameter<
    typeof implementation15.onDynamicWorkflowRunProgress
  >;

  declare private removeQueueItems: OmitThisParameter<typeof implementation13.removeQueueItems>;

  // ── config / usage ──

  declare private onModelSelected: OmitThisParameter<typeof implementation16.onModelSelected>;

  declare private onModelComplete: OmitThisParameter<typeof implementation16.onModelComplete>;

  // ── compact marker（compact 命令效果）──
  // 同一 operationId 全生命周期占同一 marker row：running → success/failed/noop/cancelled。
  // 归属：marker 落在事件到达时的行尾，客户端零归属逻辑。

  declare private onCompactLifecycle: OmitThisParameter<typeof implementation17.onCompactLifecycle>;

  // ── goal 状态机──

  declare private onTargetChanged: OmitThisParameter<typeof implementation18.onTargetChanged>;

  declare private onTargetVerification: OmitThisParameter<
    typeof implementation18.onTargetVerification
  >;

  /** goal verify boundary 身份：targetId_goalIteration。 */
  declare private goalVerifyLifecycleKey: OmitThisParameter<
    typeof implementation18.goalVerifyLifecycleKey
  >;

  // 落位：优先 anchorAssistantMessageId（解析到已渲染
  // 行的所属轮——fork copy 后是 remap 过的 child local id）；次选 anchorTurnId
  // （必须是已知轮，未知 id 不得当 turnId 用——否则会长出幽灵 turn 分组，
  // fork 前的父 runtime turnId 就是典型）；最后按事件归属。
  declare private goalVerifyTurnId: OmitThisParameter<typeof implementation18.goalVerifyTurnId>;

  // ── fork marker（forkAssistant 命令效果）──

  declare private onSessionForked: OmitThisParameter<typeof implementation17.onSessionForked>;

  // ── 内部工具 ──

  // goal 传 undefined = 不动 goal；传 null/对象 = 随本 patch 一并替换（availability 同源派生）。
  // queue 传 undefined = 不动 queue；held 派生（heldQueueInputRequiresChoice）依赖
  // queue.items.length + autoDrain，所以任何 control/goal/queue 变化都从同一处重算 A 区。
  declare private controlPatch: OmitThisParameter<typeof implementation19.controlPatch>;

  // goal 单独变化时的 patch（availability 与 goal 同源，phase/activeWorks 不变）。
  declare private goalPatch: OmitThisParameter<typeof implementation19.goalPatch>;

  // queue 单独变化时的 patch：queue 长度/autoDrain 影响 held 派生 → 同步重算 A 区。
  declare private queuePatch: OmitThisParameter<typeof implementation19.queuePatch>;

  declare private deriveContext: OmitThisParameter<typeof implementation19.deriveContext>;

  declare private upsertTurnHeader: OmitThisParameter<typeof implementation20.upsertTurnHeader>;

  declare private recordHighspeedToolStarted: OmitThisParameter<
    typeof implementation20.recordHighspeedToolStarted
  >;

  declare private recordHighspeedToolEnded: OmitThisParameter<
    typeof implementation20.recordHighspeedToolEnded
  >;

  declare private highspeedTimingForTurn: OmitThisParameter<
    typeof implementation20.highspeedTimingForTurn
  >;

  declare private openGuidedWorkSegment: OmitThisParameter<
    typeof implementation20.openGuidedWorkSegment
  >;

  declare private completeWorkSegments: OmitThisParameter<
    typeof implementation20.completeWorkSegments
  >;

  declare private turnHeaderForEvent: OmitThisParameter<typeof implementation20.turnHeaderForEvent>;

  declare private markStableForkAssistant: OmitThisParameter<
    typeof implementation6.markStableForkAssistant
  >;

  declare private isRunning: OmitThisParameter<typeof implementation19.isRunning>;

  declare private isMirroredSubagentToolEvent: OmitThisParameter<
    typeof implementation21.isMirroredSubagentToolEvent
  >;

  declare private openAssistantSegments: OmitThisParameter<
    typeof implementation21.openAssistantSegments
  >;

  declare private openSegmentIdentity: OmitThisParameter<
    typeof implementation21.openSegmentIdentity
  >;

  declare private rowBase: OmitThisParameter<typeof implementation21.rowBase>;

  declare private turnIdOf: OmitThisParameter<typeof implementation21.turnIdOf>;

  declare private ms: OmitThisParameter<typeof implementation21.ms>;

  declare private findRow: OmitThisParameter<typeof implementation21.findRow>;

  declare private updateRowIndexAfterImmutableApply: OmitThisParameter<
    typeof implementation21.updateRowIndexAfterImmutableApply
  >;

  declare private findToolRow: OmitThisParameter<typeof implementation21.findToolRow>;

  declare private findSubagentRow: OmitThisParameter<typeof implementation21.findSubagentRow>;

  declare private findSubagentLifecycleRow: OmitThisParameter<
    typeof implementation21.findSubagentLifecycleRow
  >;

  declare private subagentAgentId: OmitThisParameter<typeof implementation21.subagentAgentId>;

  declare private stringPayload: OmitThisParameter<typeof implementation21.stringPayload>;

  declare private mapSubagentStatus: OmitThisParameter<typeof implementation21.mapSubagentStatus>;
}

installProductProjectionMethods(ProductProjection.prototype);
