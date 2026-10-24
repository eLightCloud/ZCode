// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/**
 * 一个用户面产物的一个版本（journal `dwf_node.result_json` 上 `ArtifactVersionRecord` 的
 * JSON 镜像）。**刻意在这里重新声明**而不是从 @zcode/dynamic-workflow import：端口只承载
 * JSON 形状（与 {@link DynamicWorkflowRunLifecycleStatus} 同一条论证）。
 *
 * 内容产物（`file` / `markdown`）填 `contentType` / `bytes` / `uri` / `sourcePath`；预置看板
 * （`chart` / `table` / `metrics` / `board`）填 `spec`。字节永不在这里——`uri` 指向
 * tool-artifact store。
 */
export interface DynamicWorkflowRunArtifactVersion {
  version: number;
  title?: string;
  description?: string;
  contentType?: string;
  bytes?: number;
  uri?: string;
  sourcePath?: string;
  spec?: unknown;
  /** 发布时刻（epoch 毫秒）。driver 恒写入。 */
  publishedAt: number;
  /** 这一版属于 run 的交付物。 */
  primary?: true;
}

/** 用户面产物的成员种类（facade `artifact.*` 的六个成员）。 */
export type DynamicWorkflowRunArtifactKind =
  | "file"
  | "markdown"
  | "chart"
  | "table"
  | "metrics"
  | "board";

/**
 * 一个用户面产物：id 下的全部版本（按版本号升序）+ 喂给它的标签 report 计数。
 * `title` / `description` / `contentType` / `sourcePath` / `spec` 取**最新版**的值，方便
 * 只关心「现在是什么」的读者不必自己翻 versions。
 */
export interface DynamicWorkflowRunArtifact {
  id: string;
  kind: DynamicWorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  sourcePath?: string;
  spec?: unknown;
  /** 最新版号（= versions 末项的 version）。 */
  version: number;
  versions: readonly DynamicWorkflowRunArtifactVersion[];
  /** 打了这个 id 标签的 `report` 条目数（预置看板的数据量；内容产物恒 0）。 */
  itemCount: number;
  /** run 的交付物（至多一件）。`artifacts` 清单以它带头，其余按首次发布顺序。 */
  primary?: true;
}

/** 喂给某个预置产物的一条 `report` 条目，按 journal sequence 定位（看板的取数面）。 */
export interface DynamicWorkflowRunArtifactItem {
  sequence: number;
  siteId: string;
  ordinal: number;
  /** 整条 item；请求点名了 `fields` 时缺席。 */
  item?: unknown;
  /** 请求点名了 `fields` 时：路径 → 值，走不通的路径不在表里。 */
  fields?: Record<string, unknown>;
}

/**
 * {@link DynamicWorkflowRunPort.listArtifactItems} 的分页袋（cursor = journal sequence，严格大于）。
 * 两道界的语义同 {@link DynamicWorkflowRunEventPage}：条数到 `limit`、或再加一条就超过
 * `maxBytes` 时收尾，第一条总是带上。两者都由调用方（网关）给定，实现方精确兑现、不再钳。
 */
export interface DynamicWorkflowRunArtifactItemPage {
  afterSequence?: number;
  limit: number;
  maxBytes: number;
  /**
   * 只取这些字段路径（`readWorkflowArtifactField` 的规则，由 SQLite 取出），结果每条带 `fields`
   * 而不带 `item`，`maxBytes` 按取出的字段值计。缺省 = 整条 item。
   */
  fields?: readonly string[];
}

/** 看板条目的一页。`hasMore` 由存储层判定：页之后是否还有条目。 */
export interface DynamicWorkflowRunArtifactItemsResult {
  items: readonly DynamicWorkflowRunArtifactItem[];
  hasMore: boolean;
}

/** {@link DynamicWorkflowRunPort.readArtifact} 的返回：某个版本的全部字节。 */
export interface DynamicWorkflowRunArtifactBytes {
  bytes: Uint8Array;
  contentType: string;
}

/** 一个停驻中的升级问题。字段与 `escalation-raised` 事件同源，另加提问时刻。 */
export interface DynamicWorkflowRunPendingQuestion {
  /** 全局唯一的问题 id（形如 `dwfq-<runId 片段>-<seq>`）；`resolveQuestion` 只认它。 */
  qid: string;
  /** 提问的 actor，`refToString` 形态（如 `actor#1@1`）。恒在场，且在 run 内唯一定位。 */
  actor: string;
  /**
   * 这个 actor 的人类可读名（脚本里 `agent("poet")` 的 `"poet"`）。
   *
   * **匿名 actor 缺席本字段，且这里不合成任何兜底标签**：兜底是渲染决策，通知面与侧栏各有
   * 各的合适写法（一个要读成句子，一个要塞进一列）。在这里合成一个「actor#1@1」当名字，
   * 只会让两个消费者都拿不回「这个 actor 其实没有名字」这条事实。
   */
  actorName?: string;
  question: string;
  /** actor 补充的上下文（`escalate` 的可选 `context`）。 */
  context?: string;
  /** 提问时刻（epoch ms）。主代理据它判断「这个问题已经等了多久」。 */
  askedAt: number;
}
