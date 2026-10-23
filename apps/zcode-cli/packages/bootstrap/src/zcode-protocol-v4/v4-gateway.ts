import type { ConversationV4GatewayApi } from "./gateway-api.js";
import type * as implementation14 from "./gateway-attachment-binary.js";
import type * as implementation13 from "./gateway-attachment-media.js";
import type * as implementation0 from "./gateway-connection-flow.js";
import type * as implementation3 from "./gateway-detached-events.js";
import type * as implementation2 from "./gateway-event-commit.js";
import type * as implementation20 from "./gateway-event-sequence.js";
import type * as implementation19 from "./gateway-hydration.js";
import type * as implementation1 from "./gateway-live-events.js";
import { installConversationV4GatewayMethods } from "./gateway-methods.js";
import type * as implementation18 from "./gateway-publisher.js";
import type * as implementation10 from "./gateway-row-queries.js";
import type * as implementation17 from "./gateway-session-cleanup.js";
import type * as implementation4 from "./gateway-session-index.js";
import type * as implementation9 from "./gateway-workflow-artifacts.js";
import type * as implementation5 from "./gateway-workspace-config.js";
import { LocalTtftRecorder } from "./local-ttft.js";

import { localTtftFactsSchema, localTtftNow } from "@zcode/shared/zcode-protocol-v4";

// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import type {
  ConversationRowTarget,
  RoutedTopicFrame,
  SubscribeAck,
} from "@zcode/shared/zcode-protocol-v4";

import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";

import { AttachmentUploadRegistry } from "./attachment-upload-registry.js";

import { ColdSessionResumeCoordinator } from "./cold-session-resume.js";

import { CommandInbox } from "./command-inbox.js";

import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

import { SessionsIndexFanoutThrottle } from "./sessions-index-fanout-throttle.js";

import { SessionsIndexPublisherRegistry } from "./sessions-index-publisher-registry.js";

import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";

import type { TopicFrameReservation } from "./topic-frame-reservation.js";

import { ConversationTelemetryFactNormalizer } from "./conversation-telemetry-facts.js";

import { CuaPermissionObservationNormalizer } from "./cua-permission-observation.js";

import {
  defaultLogEpoch,
  encodeReservedTopicFrame,
  rowTargetActionForCommand,
} from "./gateway-support.js";

import type {
  BinaryReadCacheEntry,
  ConversationV4GatewayOptions,
  FlushState,
  HydrationBuffer,
  ProjectionEventCommitWaiter,
  RawSequenceState,
  V4GatewayHost,
  V4SubscribeDispatchResult,
} from "./gateway-support.js";

export {
  DETACHED_CHILD_PUBLISHER_GRACE_MS,
  V4CommandNoopError,
  V4CommandNotImplementedError,
  emitReservedTopicFrame,
  encodeReservedTopicFrame,
} from "./gateway-support.js";

export type {
  ConversationV4GatewayOptions,
  V4GatewayErrorContext,
  V4GatewayHost,
  V4SubscribeDispatchResult,
} from "./gateway-support.js";

export class ConversationV4Gateway {
  // 类型声明无实例字段；实现由下方唯一安装器登记在同一 owner 原型。
  declare setConnectionFlowState: ConversationV4GatewayApi["setConnectionFlowState"];
  declare flushNow: ConversationV4GatewayApi["flushNow"];
  declare ingest: ConversationV4GatewayApi["ingest"];
  declare waitForProjectionEventCommit: ConversationV4GatewayApi["waitForProjectionEventCommit"];
  declare waitForPermissionGrantCommit: ConversationV4GatewayApi["waitForPermissionGrantCommit"];
  declare ingestDetachedLiveSession: ConversationV4GatewayApi["ingestDetachedLiveSession"];
  declare pruneDetachedChildPublishers: ConversationV4GatewayApi["pruneDetachedChildPublishers"];
  declare subscribeSessionsIndex: ConversationV4GatewayApi["subscribeSessionsIndex"];
  declare subscribeSessionsIndexReserved: ConversationV4GatewayApi["subscribeSessionsIndexReserved"];
  declare subscribeWorkspaceConfig: ConversationV4GatewayApi["subscribeWorkspaceConfig"];
  declare subscribeWorkspaceConfigReserved: ConversationV4GatewayApi["subscribeWorkspaceConfigReserved"];
  declare publishWorkspaceConfig: ConversationV4GatewayApi["publishWorkspaceConfig"];
  declare subscribe: ConversationV4GatewayApi["subscribe"];
  declare subscribeReserved: ConversationV4GatewayApi["subscribeReserved"];
  declare unsubscribe: ConversationV4GatewayApi["unsubscribe"];
  declare resyncReserved: ConversationV4GatewayApi["resyncReserved"];
  declare plans: ConversationV4GatewayApi["plans"];
  declare workflowRunEvents: ConversationV4GatewayApi["workflowRunEvents"];
  declare workflowRuns: ConversationV4GatewayApi["workflowRuns"];
  declare workflowRunArtifacts: ConversationV4GatewayApi["workflowRunArtifacts"];
  declare workflowRunArtifactData: ConversationV4GatewayApi["workflowRunArtifactData"];
  declare workflowRunArtifactRead: ConversationV4GatewayApi["workflowRunArtifactRead"];
  declare workflowRunWorkspace: ConversationV4GatewayApi["workflowRunWorkspace"];
  declare workflowRunNodeResult: ConversationV4GatewayApi["workflowRunNodeResult"];
  declare rowsRange: ConversationV4GatewayApi["rowsRange"];
  declare fileChanges: ConversationV4GatewayApi["fileChanges"];
  declare backgroundBashOutput: ConversationV4GatewayApi["backgroundBashOutput"];
  declare fileRewindPreview: ConversationV4GatewayApi["fileRewindPreview"];
  declare attachmentBegin: ConversationV4GatewayApi["attachmentBegin"];
  declare attachmentChunk: ConversationV4GatewayApi["attachmentChunk"];
  declare attachmentCommit: ConversationV4GatewayApi["attachmentCommit"];
  declare attachmentAbort: ConversationV4GatewayApi["attachmentAbort"];
  declare attachmentRead: ConversationV4GatewayApi["attachmentRead"];
  declare conversationAttachmentRead: ConversationV4GatewayApi["conversationAttachmentRead"];
  declare conversationAttachmentStat: ConversationV4GatewayApi["conversationAttachmentStat"];
  declare attachmentPreviewSource: ConversationV4GatewayApi["attachmentPreviewSource"];
  declare handleCommand: ConversationV4GatewayApi["handleCommand"];
  declare queryCommands: ConversationV4GatewayApi["queryCommands"];
  declare getQueueItem: ConversationV4GatewayApi["getQueueItem"];
  declare hasQueueItemKind: ConversationV4GatewayApi["hasQueueItemKind"];
  declare hasQueuedDelivery: ConversationV4GatewayApi["hasQueuedDelivery"];
  declare getQueueLength: ConversationV4GatewayApi["getQueueLength"];
  declare hasResidencyBlockingCommands: ConversationV4GatewayApi["hasResidencyBlockingCommands"];
  declare getQueueHead: ConversationV4GatewayApi["getQueueHead"];
  declare getInputRoutingMode: ConversationV4GatewayApi["getInputRoutingMode"];
  declare getSessionFollowupMode: ConversationV4GatewayApi["getSessionFollowupMode"];
  declare getMessageIdForRow: ConversationV4GatewayApi["getMessageIdForRow"];
  declare resolveRowActionTarget: ConversationV4GatewayApi["resolveRowActionTarget"];
  declare getMessageIdsForTurnRow: ConversationV4GatewayApi["getMessageIdsForTurnRow"];
  declare isLatestAssistantSegmentRow: ConversationV4GatewayApi["isLatestAssistantSegmentRow"];
  declare resolveStableForkCandidate: ConversationV4GatewayApi["resolveStableForkCandidate"];
  declare isLatestRetryAssistantRow: ConversationV4GatewayApi["isLatestRetryAssistantRow"];
  declare isLatestEditableUserRow: ConversationV4GatewayApi["isLatestEditableUserRow"];
  declare getTurnIdForRow: ConversationV4GatewayApi["getTurnIdForRow"];
  declare getTurnRewindAnchor: ConversationV4GatewayApi["getTurnRewindAnchor"];
  declare disposeSession: ConversationV4GatewayApi["disposeSession"];
  declare deactivateSession: ConversationV4GatewayApi["deactivateSession"];
  declare assertSessionRuntimeDeactivatable: ConversationV4GatewayApi["assertSessionRuntimeDeactivatable"];
  declare hasConversationSubscribers: ConversationV4GatewayApi["hasConversationSubscribers"];
  declare collectMemoryDiagnostics: ConversationV4GatewayApi["collectMemoryDiagnostics"];
  declare dispose: ConversationV4GatewayApi["dispose"];
  declare updateSharedContextImport: ConversationV4GatewayApi["updateSharedContextImport"];

  private readonly publishers = new Map<string, ConversationTopicPublisher>();
  /** sessions-index：workspaceId → 列表 publisher（与 conversation 并列，独立 seq/logEpoch）。 */
  private readonly indexPublishers = new SessionsIndexPublisherRegistry();
  /** workspace-config：workspaceId → 配置目录 publisher（conflated 整体替换态）。 */
  private readonly configPublishers = new Map<string, WorkspaceConfigPublisher>();
  /** 已完成首次 hydration 的 session（避免重复重建 / 双计，见 hydratePublisher）。 */
  private readonly hydratedSessions = new Set<string>();
  /** 首次 hydration 按 session 单飞；并发 pane 共享同一份重建结果。 */
  private readonly hydrationInFlight = new Map<string, Promise<ConversationTopicPublisher>>();
  /** cold activation 到 hydration 的 READY 水位；只阻塞本次恢复期间的 command/query。 */
  private readonly readyFlights = new Map<string, Promise<ConversationTopicPublisher>>();
  /** load await 窗口内的 raw accepted events；重建后按 cursor/eventId 补回。 */
  private readonly hydrationBuffers = new Map<string, HydrationBuffer>();
  /** transcript 合成序列与 runtime raw 序列之间的 per-session 单调映射。 */
  private readonly rawSequenceStates = new Map<string, RawSequenceState>();
  /** connection-independent；command admission 与 transport subscription 生命周期解耦。 */
  private readonly projectionEventCommitWaiters = new Map<
    string,
    Map<string, Set<ProjectionEventCommitWaiter>>
  >();
  /** 没有独立 bootstrap record、但由父 runtime 持续转发 raw events 的 live child。 */
  private readonly detachedLiveSessions = new Set<string>();
  /**
   * detached subagent child 的父 record 归属与终态时间。child 没有自己的 record，publisher 只能随父 record 释放，
   * 或在 turn 结束且无订阅者、超过 grace 后由低频 tick 释放；否则会驻留到进程退出。
   */
  private readonly detachedChildParent = new Map<string, string>();
  private readonly detachedChildrenByParent = new Map<string, Set<string>>();
  private readonly detachedTerminalAt = new Map<string, number>();
  /** 冷恢复协调器（既有 activation 单飞 + 错误分型）。 */
  private readonly coldResume: ColdSessionResumeCoordinator;
  /** 订阅 → flush 调度状态（publisher 内部不持有定时器，调度归网关）。 */
  private readonly flushStates = new Map<string, FlushState>();
  /** ACK/outbox 尚未 admission 的 control reservation 禁止被 online flush 抢先发送。 */
  private readonly controlReservations = new WeakSet<object>();
  /** transport high-water pause 只按 trusted connectionId 隔离，不改变 ingest/publisher 真值。 */
  private readonly pausedConnections = new Set<string>();
  /** 一个越界周期只触发一次 runtime stop；终态事件到达后解除。 */
  private readonly projectionFaultedSessions = new Set<string>();
  private readonly inbox: CommandInbox;
  private readonly attachmentUploads: AttachmentUploadRegistry;
  private readonly binaryReadCache = new Map<string, BinaryReadCacheEntry>();
  private binaryReadCacheBytes = 0;
  private readonly localTtft = new LocalTtftRecorder(
    localTtftNow,
    () => {
      this.host.onError?.(
        "v4.localTtft.completedCapacity",
        new Error("TTFT completed record capacity exceeded"),
      );
    },
    (facts) => {
      const parsed = localTtftFactsSchema.safeParse(facts);
      if (parsed.success) this.host.emitLocalTtftFacts?.(parsed.data);
    },
  );
  /** 高频进度事件的 index fan-out 节流（14-sessions-index「事件 fan-out 节奏」）。 */
  private readonly indexFanoutThrottle = new SessionsIndexFanoutThrottle({
    publish: (sessionId) => this.publishCurrentSummaryToIndex(sessionId),
  });
  private readonly attachmentPruneTimer: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly createLogEpoch: (sessionId: string) => string;
  private readonly telemetryNormalizer = new ConversationTelemetryFactNormalizer();
  private readonly cuaPermissionNormalizer = new CuaPermissionObservationNormalizer();
  private readonly telemetryEventIds = new Set<string>();
  private disposed = false;

  /** session entry 状态变更后的轻量 metadata 更新，不重放 conversation event。 */

  constructor(
    private readonly host: V4GatewayHost,
    options: ConversationV4GatewayOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createLogEpoch = options.createLogEpoch ?? defaultLogEpoch;
    this.coldResume = new ColdSessionResumeCoordinator(host);
    this.inbox = new CommandInbox({
      getRevision: (sessionId) => {
        if (!this.host.sessionExists(sessionId)) return null;
        // 已知会话但尚无事件 → 投影未建，revision 视为 0（draft 起点）。
        return this.publishers.get(sessionId)?.getSnapshot().revision ?? 0;
      },
      getLogEpoch: (sessionId) => this.publishers.get(sessionId)?.getSnapshot().logEpoch ?? null,
      validateRowTarget: (envelope) => {
        const action = rowTargetActionForCommand(envelope.type);
        if (!action || envelope.sessionId === null) return { verdict: "allow" };
        const target = (envelope.payload as { target?: ConversationRowTarget }).target;
        if (!target) return { verdict: "reject", reasonCode: "proto.invalidPayload" };
        const resolution = this.publishers
          .get(envelope.sessionId)
          ?.resolveRowActionTarget(target, action);
        if (!resolution) return { verdict: "stale", reasonCode: "proto.staleTarget" };
        if (resolution.ok) return { verdict: "allow" };
        return resolution.status === "stale"
          ? { verdict: "stale", reasonCode: resolution.reasonCode }
          : { verdict: "reject", reasonCode: resolution.reasonCode };
      },
      lookupTranscriptCommand: (key) => this.host.lookupTranscriptCommand?.(key) ?? null,
      lookupTimelineCommand: (key) => this.host.lookupTimelineCommand?.(key) ?? null,
      lookupChildCommand: (key) => this.host.lookupChildCommand?.(key) ?? null,
      lookupDiscardedCommand: (key) => this.host.lookupDiscardedCommand?.(key) ?? null,
      now: this.now,
    });
    this.attachmentUploads = new AttachmentUploadRegistry({
      now: this.now,
      putSessionAttachment: async (sessionId, input) => {
        if (!this.host.putSessionAttachment) {
          throw new Error("fault.attachment.putUnsupported");
        }
        return this.host.putSessionAttachment(sessionId, input);
      },
    });
    this.attachmentPruneTimer = setInterval(
      () => this.attachmentUploads.pruneExpired(),
      Math.min(30_000, PROTOCOL_V4_LIMITS.attachmentUploadTtlMs),
    );
    (
      this.attachmentPruneTimer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();
  }

  declare private clearConnectionFlushTimers: OmitThisParameter<
    typeof implementation0.clearConnectionFlushTimers
  >;

  declare private flushConnection: OmitThisParameter<typeof implementation0.flushConnection>;

  /** 权威事件入口：投影推进 + 各订阅者按 profile.flushWindowMs 调度打帧。 */

  declare private emitLiveTelemetryFact: OmitThisParameter<
    typeof implementation1.emitLiveTelemetryFact
  >;

  /** 等待指定 raw event 真正完成 reorder drain + publisher projection apply。 */

  /** 授权已经提交到任务事务，失败重试必须重放权威日志，不能再次提权或丢弃提交事实。 */

  declare private ingestNormalizedEvent: OmitThisParameter<
    typeof implementation1.ingestNormalizedEvent
  >;

  /**
   * subagent child 使用父 record 的外部 sink，但保留独立 session topic。显式登记这类
   * detached live session，避免把任意偶然存在的 cold publisher 都误判为运行中 child。
   */

  /**
   * 低频 tick 兜底：释放已终态、无订阅者、且没有自己 record 的 detached child publisher。
   * 释放后再被订阅走既有 cold resume（child 作为 subagent_child 持久化在 session store）。返回释放数。
   */

  declare private releaseDetachedChild: OmitThisParameter<
    typeof implementation3.releaseDetachedChild
  >;

  /**
   * 把某会话的最新摘要推进到其 workspace 的 sessions-index publisher，并 flush 给列表订阅者。
   * projection 必须在无列表订阅者时也继续推进，保证下一次 snapshot 读取权威当前态；
   * 高频流式增量（ModelStreaming）不触发列表重算，避免抖动（预览在 turn 收口/其他事件时更新）。
   * 旧宿主无 getSessionWorkspaceId → 整体 no-op。
   */
  declare private fanOutToIndex: OmitThisParameter<typeof implementation4.fanOutToIndex>;

  /**
   * 把当前完整 projection 发布到 sessions-index。
   *
   * fork child 的 resume 会先用少量 live event 建出暂态 draft publisher，
   * 随后的 synthesized hydration 才补齐继承历史。只在 ingest(event) 时 fan-out 的话，
   * hydration 完成后若没有下一条 runtime event，child 就永远停在 draft 基线，
   * task-index syncer 无法观察到 draft→visible，也就不会创建侧栏 task row。
   */
  declare private publishCurrentSummaryToIndex: OmitThisParameter<
    typeof implementation4.publishCurrentSummaryToIndex
  >;

  /** 会话列表元信息（宿主 hook 缺省时的兜底：createdAt=0，lastActivityAt=now）。 */
  declare private resolveIndexMeta: OmitThisParameter<typeof implementation4.resolveIndexMeta>;

  /** 把某 workspace index publisher 的未发增量帧推给所有列表订阅者。 */
  declare private flushIndex: OmitThisParameter<typeof implementation4.flushIndex>;

  /**
   * sessions-index 订阅：订阅某 workspace 的会话列表（与 conversation subscribe 并列，
   * 同一 RPC 方法按 topic 前缀分派）。冷启动：store 摘要种子 + 已加载会话 live 投影覆盖。
   */

  /** 建/取某 workspace 的 index publisher；建时 store 摘要种子 + live 投影覆盖。 */
  declare private ensureIndexPublisher: OmitThisParameter<
    typeof implementation4.ensureIndexPublisher
  >;

  /** 同 workspace 串行区：可重试 claim/重读与 publisher 构造必须观察同一份最终快照。 */
  declare private ensureIndexPublisherExclusive: OmitThisParameter<
    typeof implementation4.ensureIndexPublisherExclusive
  >;

  /**
   * workspace-config 订阅：订阅某 workspace 的配置目录（与 conversation subscribe 并列，
   * 同一 RPC 方法按 topic 前缀分派）。订阅时经宿主钩子拉取当前配置作种子。
   */

  /**
   * 配置目录发布入口（宿主在 provider registry 应用 / workspace 默认项变更后调用，
   * 直接携带已构建好的目录，不回头重拉宿主，避免重复 buildWorkspaceState 的临时 app 成本）。
   * conflation 在 publisher 内完成（未变化不产帧）；无 publisher 时同步建一个空种子的
   * publisher 存住最新态，后续订阅者据此拿到完整 snapshot。
   */

  declare private pullWorkspaceConfig: OmitThisParameter<
    typeof implementation5.pullWorkspaceConfig
  >;

  /** 建/取某 workspace 的 config publisher；建时经宿主钩子拉取当前目录作种子。 */
  declare private ensureConfigPublisher: OmitThisParameter<
    typeof implementation5.ensureConfigPublisher
  >;

  /** 把某 workspace config publisher 的未发增量帧推给所有订阅者。 */
  declare private flushConfig: OmitThisParameter<typeof implementation5.flushConfig>;

  /** v4/conversation/subscribe：裁决 + server 内部 initial frame，公共响应由 server 只取 ACK。 */

  /**
   * v4/conversation/resync：按 owned topic/connection 精确命中现有 subscription，
   * 保持 subId/profile 不变，从客户端 base 重新裁决 resume/snapshot。
   */

  /**
   * v4/conversation/rowsRange：按 beforeRowId 游标向上取一窗
   * 历史行。只读 query，不建订阅；数据源 = 该会话投影全量行——冷会话（重启后直开
   * 历史）复用与 subscribe 相同的冷恢复 + hydration 管线先把投影建起来。
   */

  /** 完整有效 projection 的终态计划目录；冷会话复用订阅 hydration。 */

  /**
   * workflow run 事件日志的分页读取（cursor = journal sequence）。
   *
   * 与 rows/range、plans 同族：只读、无状态、超时重发安全。刻意**不是** v4 command——
   * command 的 ACK 结果是那个封闭的「变更结果」判别联合，一页只读事件不属于那个词汇表。
   *
   * 一页的条数与字节两道界在这里定（docs/execution-engine.md「Reading the journal」）：条数取
   * 调用方的 limit，缺省为协议上限；字节恒为协议上限，renderer 不能放宽。`hasMore` 由存储层
   * 判定——页可能因字节提前收尾，「取满 limit」已经不是判据。
   */

  /**
   * dwf run 的枚举 query。与
   * workflowRunEvents 同族：只读、无状态、超时重发安全。limit 的缺省与钳制在 CLI 侧
   * （run service），这里只透传；`resumable` 由 CLI 按 resume 门的同一个谓词算好。
   */

  /**
   * workflow run 的**用户面产物**清单。
   * 与 workflowRunEvents 同族：只读、无状态、超时重发安全。
   *
   * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层
   * 返回值（引擎内部对后者的同名叫法）。
   *
   * 未知 runId 回空清单而不是错误：一个已被淘汰 / 从未存在的 run 没有产物，这是一个
   * 事实而不是故障——同一姿态见事件日志对越界 cursor 的处理。
   */

  /**
   * 预置看板的取数面：喂给某个产物的 `report` 条目分页。
   *
   * 条数的**缺省与钳制**、以及字节上界都在这里定（存储层精确兑现、绝不自造页大小也绝不再钳）。`fields` 原样下传：看板只要 spec 点名的字段，由 SQLite 取出；`hasMore` 由存储层判定——页可能因字节提前收尾，所以判据绝不能是
   * 「这页正好满」，也不再是网关多取一条。
   */

  /**
   * 内容产物的字节，**逐字照 attachmentRead**：一次一块、≤ 512 KiB（schema 已钉住 limit 的
   * 上界），`nextOffset` 为 null 即读到尾。
   *
   * **授权全在宿主侧**（端口实现）：该 run 必须属于 `sessionId` 这个会话 ∧ journal 里有
   * `(artifactId, version)` 的 completed 行，然后才拿**行上的** uri 去 store 读。网关只做
   * 参数校验与分块——它没有 journal，也不该有第二份授权判据（两处各判一次，同一个 id
   * 迟早会在两层上得到不同的解释）。宿主回 `undefined` = 无此版本 / 不是你的 run /
   * 这是块看板（没有字节），三者对调用方是同一个业务事实，这里归一成结构化的 not found。
   *
   * `offset` 越界不是错误：返回空块 + `nextOffset: null`，与读到尾同一形态。
   */

  /**
   * 工作区 transcript 的清单：一个 run 的
   * `files.*` / `git.*` / `world.run` 行，不带正文。
   *
   * 宿主回 `undefined`（未知 run / 不是你的 run）得到空清单而不是错误：与产物清单同一姿态，
   * 也是授权链「不告诉越权者猜对了哪一半」的要求。清单超过 maxNodes 截尾并置 `truncated`——
   * 一个循环里跑了三千次 `world.run` 的 run 不该把侧板撑爆。
   */

  /**
   * 一个工作区节点的正文，按 `maxBytes` 保形有界化（缺省与上限都是 resultMaxBytes，钳在这里）。
   * 授权全在宿主侧；宿主回 `undefined` = 无此节点 / 不是你的 run / 不是 world 行，归一成
   * 结构化的 not found。
   */

  /**
   * 一个产物版本的**整份**字节，带缓存。
   *
   * 端口的 `readArtifact` 返回的是整份字节，而
   * `workflowRunArtifactRead` 是**分块**查询——不缓存的话，一个 20 MiB 的 PDF 按 512 KiB
   * 分 40 块取，就会把整份文件从 store 读 40 遍（800 MiB 的 I/O），而且每一块都要重走一遍
   * journal 授权链。`attachmentRead` 早就有这张表，这里复用它（见 {@link BinaryReadCacheEntry}
   * 关于两个家族共用一张表的论证）。
   *
   * 缓存的是 **promise 而不是结果**，且在发起前就写进表里：并发抓取的多个分块因此共享
   * 同一次读，而不是各自发起一次再各自写一遍缓存。
   *
   * 授权不因缓存被绕过：键里带着 `sessionId`，而 `sessionId` 正是端口那条授权链
   * （run 的 parentSessionId 必须等于它）的比对对象——换一个会话就是另一个键，必然重新
   * 走一次端口。会话销毁时按 `sessionId` 整片清掉，与附件同一条规则。
   *
   * 宿主回 `undefined`（不是你的 run / 无此版本 / 是块看板）在这里**抛错**而不是被缓存：
   * 走既有的 catch 分支把条目删掉，于是一个"发布刚落库、读稍微早了一步"的竞态不会被
   * 负缓存钉死 30 秒。
   */
  declare private readWorkflowArtifactPayload: OmitThisParameter<
    typeof implementation9.readWorkflowArtifactPayload
  >;

  /**
   * dwf 两个 journal 读面的宿主 record 前置。
   *
   * 这两个 query 都经 app 能力读 journal，而宿主按 sessionId 找 record——历史
   * 会话的 record 只由**订阅**路径激活。renderer 里发现查询的 effect 声明在 lease/订阅
   * effect 之前，而 CLI 严格串行派发请求（`zcode-protocol/transport.ts`，只有 session/stop
   * 越队），于是「重启后打开历史会话」时它必然先于订阅被处理、必然拿到 sessionNotFound：
   * 工具卡的 join 回退整块消失，卡片退回编译态，被打断的 run 连入口都没有。
   *
   * 只拉 record，**不**建 READY publisher：journal 与 conversation log 无关，读一页 run
   * 不需要投影（同一判断见这两个 query 刻意不带 atSeq/atLogEpoch）。习语与 attachmentBegin
   * 逐字相同；`ensureResumed` 自带按会话单飞，与并发订阅共享同一次 activation。
   *
   * 活性判定必须与 subscribe 同一条
   * `hasLiveConversation`，不能只看 `sessionExists`。dwf actor transcript 是 detached live
   * 会话——真 runtime 活在 run service 里、宿主刻意没有 record；嵌套 SessionPane 的发现
   * 查询带着 actor id 打到这里，旧判定就对一条**正在运行**的会话物化出第二个（幽灵）
   * runtime：它向同一份事件日志追加 SessionResumed、丢弃 pending steer、重放 resume hooks，
   * 双写把序列账搞乱，transcript 从此定格（症状是直播冻结在「已工作 xx 秒」）。
   */
  declare private ensureHostRecordForJournalRead: OmitThisParameter<
    typeof implementation10.ensureHostRecordForJournalRead
  >;

  declare private resolveQueryRowTarget: OmitThisParameter<
    typeof implementation10.resolveQueryRowTarget
  >;

  /** begin 只 admission metadata，不解码/暂存 full payload。 */

  declare private resolveReadableMediaAttachment: OmitThisParameter<
    typeof implementation13.resolveReadableMediaAttachment
  >;

  /**
   * 读取附件全部字节（带 TTL/容量缓存）。
   *
   * 注意语义：conversationAttachmentRead 的 offset/limit 是**切片**，不是流式读取——
   * 每个首次请求都会把整个附件物化进内存再切片，后续 chunk 命中同一份缓存。
   * 接入方不要把 chunk 协议当作「按需分段拉取」来规划超大文件；真正的 range 读取
   * 需要 host 侧 readBinaryFile 支持 offset（尚未实现）。
   */
  declare private readAttachmentPayload: OmitThisParameter<
    typeof implementation14.readAttachmentPayload
  >;

  declare private pruneBinaryReadCache: OmitThisParameter<
    typeof implementation14.pruneBinaryReadCache
  >;

  declare private deleteBinaryReadCacheEntry: OmitThisParameter<
    typeof implementation14.deleteBinaryReadCacheEntry
  >;

  /** v4/conversation/unsubscribe。 */

  /**
   * v4/command：inbox 六态裁决；accepted 时执行副作用并把终态随响应返回。
   *
   * 这里曾经"立即回初始 ACK、后台 settle"，
   * 导致 createSession/forkAssistant 的调用方拿不到 result.sessionId（settle 只回填
   * 幂等表，只有同 commandId 重试才能读到）——违反
   * 「accepted 即时带 result」。命令副作用本身是快返回的（sendPrompt 后台起 turn），
   * await 不会把 RPC 挂到整个 turn 结束，所以同步等待终态。
   * settle 仍然固化结果供 duplicate 重放。
   */

  /** v4/commands/query：同 key 与 handleCommand 共用 CommandInbox gate。 */

  /** Resident 回收保护：publisher queue 与 CommandInbox pinned facts 任一存在都不可关闭。 */

  /**
   * 当前输入路由模式（v4 原生能力，供命令层 host.getInputRoutingMode 使用）：
   * held choice 裁决（heldQueueInputRequiresChoice）读投影 inputRouting.mode。
   */

  /**
   * rowId → 权威 messageId（v4 原生能力，供 forkAssistant/retryTurn 定位 assistant 行）。
   * 会话无 publisher / 行不存在 / 非 assistant 行 → null（命令层据此 reject，不静默兜底）。
   */

  /** rowId → 所属 product turn 内所有 transcript messageId（文件摘要撤销 / diff 查询）。 */

  /** fork 目标必须是所属轮最后一段 assistantText（无投影 → null，按未知处理）。 */

  /** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */

  /** latestQueryEditOnly：edit 目标必须是当前投影里的最后一条 realUser userInput row。 */

  /** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */

  /**
   * rowId → 所属 turn 的 rewind 锚点 messageId（供 editUserQuery：user 行无 messageId，
   * 用同 turn 内 assistant 行的 messageId 作 `/rewind` 目标）。
   */

  /** 会话关闭：清 publisher 与其全部订阅调度；hydration 标记同清（重开走冷启动重建）；
   *  并从其 workspace index 移除该会话（session.removed 推给列表订阅者）。 */

  /**
   * Resident 容量去激活：与 disposeSession 相同的内存运行态清理，但**不**从 sessions-index
   * 移除会话（不发 session.removed）——去激活是纯内存优化，侧边栏列表项必须原样
   * 保留，再次订阅经冷恢复透明重建。
   */

  /**
   * Resident 回收纯预检：调用方可在拆 runtime event subscription 前拒绝不安全回收。
   * deactivateSession 内仍复用同一校验，防止未来新增调用方绕过执行面 preflight。
   */

  /** Resident 回收判定：该会话是否还有 conversation 订阅者（桌面 tab / 手机 remote）。 */

  /**
   * 内存诊断计数器。只读 size，不触碰状态。
   * detachedLive 用于观察子 session publisher 是否随父 session 释放。
   */

  declare private cleanupSessionRuntime: OmitThisParameter<
    typeof implementation17.cleanupSessionRuntime
  >;

  /** 测试探针：立即排空某订阅（绕过定时器）。 */

  declare private ensurePublisher: OmitThisParameter<typeof implementation18.ensurePublisher>;

  /**
   * config 种子注入（防御式：种子失败不打断 conversation 主路径）。
   * 幂等且事件优先（seedConfig 跳过事件触碰过的字段），故在 publisher 创建与
   * hydration 收尾两处都调用——创建时机可能早于 record 完全就位（createSessionRecord
   * 事件接线期间），hydration 处补一次兜住该窗口。
   */
  declare private seedPublisherConfig: OmitThisParameter<
    typeof implementation18.seedPublisherConfig
  >;

  /**
   * 冷恢复 READY 只在明确需要 activation 的入口创建；hydratePublisher 保持 projection-only。
   * 注册 promise 早于 activation，避免 record 提前入册后并发 command/query 越过恢复水位。
   */
  declare private ensureColdReadyPublisher: OmitThisParameter<
    typeof implementation18.ensureColdReadyPublisher
  >;

  /**
   * 首次订阅时的投影重建（hydration）。语义见 subscribe 注释；
   * synthesized 事件按 sequenceNumber 去重（publisher 已 ingest 过的 live 事件不重放）。
   */
  declare private hydratePublisher: OmitThisParameter<typeof implementation18.hydratePublisher>;

  declare private performHydration: OmitThisParameter<typeof implementation19.performHydration>;

  /**
   * cold 合成会把事件重新编号为 1..N，而 runtime 仍沿用 eventStore raw seq。这里用
   * source cursor 建立 N-C 偏移；raw seq=0（live-only child）则顺延，并同步校正后续偏移。
   * eventId 兜住 snapshot/buffer 同时看见同一事件的竞态，cursor 兜住已入 snapshot 的事件。
   */
  declare private normalizeRuntimeEventSequence: OmitThisParameter<
    typeof implementation20.normalizeRuntimeEventSequence
  >;

  declare private getOrCreateRawSequenceState: OmitThisParameter<
    typeof implementation20.getOrCreateRawSequenceState
  >;

  declare private resolveProjectionEventCommit: OmitThisParameter<
    typeof implementation2.resolveProjectionEventCommit
  >;

  declare private rejectProjectionEventCommit: OmitThisParameter<
    typeof implementation2.rejectProjectionEventCommit
  >;

  declare private rejectProjectionEventWaiters: OmitThisParameter<
    typeof implementation2.rejectProjectionEventWaiters
  >;

  /**
   * 运行中 subagent 没有独立 bootstrap record，但 raw child events 会先建立 publisher。
   * publisher 已存在就代表 conversation live 可订阅，不能再把同一 child cold resume 成
   * 第二个 runtime；真正的历史 session 仍由 host record / persisted resume 负责。
   */
  declare private hasLiveConversation: OmitThisParameter<
    typeof implementation18.hasLiveConversation
  >;

  declare private seedPublisherUsage: OmitThisParameter<typeof implementation18.seedPublisherUsage>;

  declare private scheduleFlush: OmitThisParameter<typeof implementation0.scheduleFlush>;

  declare private emitReservation: OmitThisParameter<typeof implementation0.emitReservation>;

  private subscribeDispatch<F extends RoutedTopicFrame>(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<F> | null,
    afterCommit?: () => void,
  ): V4SubscribeDispatchResult<F> {
    const initialWires = reservation
      ? encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>)
      : [];
    if (reservation) this.controlReservations.add(reservation);
    let afterCommitRan = false;
    return {
      ack,
      initialFrame: reservation?.frame ?? null,
      initialWires,
      commit: () => {
        if (!reservation) return true;
        this.controlReservations.delete(reservation);
        const committed = reservation.commit();
        if (committed && !afterCommitRan) {
          afterCommitRan = true;
          // control reservation 等 ACK/outbox admission 时，既有 flush timer
          // 可能已触发并因同一 inFlight 被抑制。commit 后必须主动重驱动 publisher，
          // 否则期间积累的 delta 会一直等到下一次 ingest/publish 才可见。
          afterCommit?.();
        }
        return committed;
      },
    };
  }
}

installConversationV4GatewayMethods(ConversationV4Gateway.prototype);
