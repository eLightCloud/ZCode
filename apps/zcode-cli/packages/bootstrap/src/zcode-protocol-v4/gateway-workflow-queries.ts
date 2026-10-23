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
  V4ConversationPlansResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";

import {
  WORKFLOW_ARTIFACT_LIMITS,
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  WORKFLOW_WORKSPACE_LIMITS,
  v4ConversationPlansParamsSchema,
  v4ConversationWorkflowRunArtifactDataParamsSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadParamsSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsParamsSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunEventsParamsSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunNodeResultParamsSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceParamsSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  v4ConversationWorkflowRunsParamsSchema,
  v4ConversationWorkflowRunsResultSchema,
} from "@zcode/shared/zcode-protocol-v4";

import { V4CapabilityUnsupportedError } from "./commands/handlers/interaction-background.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
/** 完整有效 projection 的终态计划目录；冷会话复用订阅 hydration。 */

export async function plans(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4ConversationPlansResult> {
  const params = v4ConversationPlansParamsSchema.parse(rawParams);
  const existingReady = this.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !this.hasLiveConversation(params.sessionId)
      ? await this.ensureColdReadyPublisher(params.sessionId)
      : await this.hydratePublisher(params.sessionId);
  return publisher.getPlans();
}

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

export async function workflowRunEvents(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunEventsResult> {
  const params = v4ConversationWorkflowRunEventsParamsSchema.parse(rawParams);
  if (!this.host.listDynamicWorkflowRunEvents) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", params.sessionId);
  }
  await this.ensureHostRecordForJournalRead(params.sessionId);
  const page = await this.host.listDynamicWorkflowRunEvents(params.sessionId, {
    runId: params.runId,
    ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
    limit: params.limit ?? WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
    maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
  });
  return v4ConversationWorkflowRunEventsResultSchema.parse(page);
}

/**
 * dwf run 的枚举 query。与
 * workflowRunEvents 同族：只读、无状态、超时重发安全。limit 的缺省与钳制在 CLI 侧
 * （run service），这里只透传；`resumable` 由 CLI 按 resume 门的同一个谓词算好。
 */

export async function workflowRuns(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunsResult> {
  const params = v4ConversationWorkflowRunsParamsSchema.parse(rawParams);
  if (!this.host.listDynamicWorkflowRuns) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", params.sessionId);
  }
  await this.ensureHostRecordForJournalRead(params.sessionId);
  const runs = await this.host.listDynamicWorkflowRuns(params.sessionId, {
    ...(params.limit === undefined ? {} : { limit: params.limit }),
  });
  return v4ConversationWorkflowRunsResultSchema.parse({ runs });
}

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

export async function workflowRunArtifacts(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunArtifactsResult> {
  const params = v4ConversationWorkflowRunArtifactsParamsSchema.parse(rawParams);
  if (!this.host.listDynamicWorkflowRunArtifacts) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", params.sessionId);
  }
  await this.ensureHostRecordForJournalRead(params.sessionId);
  const artifacts = await this.host.listDynamicWorkflowRunArtifacts(params.sessionId, {
    runId: params.runId,
  });
  return v4ConversationWorkflowRunArtifactsResultSchema.parse({ artifacts: artifacts ?? [] });
}

/**
 * 预置看板的取数面：喂给某个产物的 `report` 条目分页。
 *
 * 条数的**缺省与钳制**、以及字节上界都在这里定（存储层精确兑现、绝不自造页大小也绝不再钳）。`fields` 原样下传：看板只要 spec 点名的字段，由 SQLite 取出；`hasMore` 由存储层判定——页可能因字节提前收尾，所以判据绝不能是
 * 「这页正好满」，也不再是网关多取一条。
 */

export async function workflowRunArtifactData(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunArtifactDataResult> {
  const params = v4ConversationWorkflowRunArtifactDataParamsSchema.parse(rawParams);
  if (!this.host.listDynamicWorkflowRunArtifactItems) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifactItems", params.sessionId);
  }
  await this.ensureHostRecordForJournalRead(params.sessionId);
  const limit = Math.max(
    1,
    Math.min(
      params.limit ?? WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
      WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage,
    ),
  );
  const page = await this.host.listDynamicWorkflowRunArtifactItems(params.sessionId, {
    runId: params.runId,
    artifactId: params.artifactId,
    ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
    limit,
    maxBytes: WORKFLOW_ARTIFACT_LIMITS.maxPageBytes,
    ...(params.fields === undefined ? {} : { fields: params.fields }),
  });
  return v4ConversationWorkflowRunArtifactDataResultSchema.parse(page);
}

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

export async function workflowRunArtifactRead(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunArtifactReadResult> {
  const params = v4ConversationWorkflowRunArtifactReadParamsSchema.parse(rawParams);
  if (!this.host.readDynamicWorkflowRunArtifact) {
    throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", params.sessionId);
  }
  await this.ensureHostRecordForJournalRead(params.sessionId);
  const artifact = await this.readWorkflowArtifactPayload(params);
  const totalBytes = artifact.bytes.byteLength;
  const start = Math.min(params.offset, totalBytes);
  const end = Math.min(start + params.limit, totalBytes);
  const chunk = artifact.bytes.subarray(start, end);
  return v4ConversationWorkflowRunArtifactReadResultSchema.parse({
    dataBase64: Buffer.from(chunk).toString("base64"),
    mediaType: artifact.mediaType,
    totalBytes,
    nextOffset: end < totalBytes ? end : null,
  });
}

/**
 * 工作区 transcript 的清单：一个 run 的
 * `files.*` / `git.*` / `world.run` 行，不带正文。
 *
 * 宿主回 `undefined`（未知 run / 不是你的 run）得到空清单而不是错误：与产物清单同一姿态，
 * 也是授权链「不告诉越权者猜对了哪一半」的要求。清单超过 maxNodes 截尾并置 `truncated`——
 * 一个循环里跑了三千次 `world.run` 的 run 不该把侧板撑爆。
 */

export async function workflowRunWorkspace(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunWorkspaceResult> {
  const params = v4ConversationWorkflowRunWorkspaceParamsSchema.parse(rawParams);
  if (!this.host.listDynamicWorkflowRunWorkspaceNodes) {
    throw new V4CapabilityUnsupportedError(
      "listDynamicWorkflowRunWorkspaceNodes",
      params.sessionId,
    );
  }
  await this.ensureHostRecordForJournalRead(params.sessionId);
  const nodes =
    (await this.host.listDynamicWorkflowRunWorkspaceNodes(params.sessionId, {
      runId: params.runId,
    })) ?? [];
  const truncated = nodes.length > WORKFLOW_WORKSPACE_LIMITS.maxNodes;
  return v4ConversationWorkflowRunWorkspaceResultSchema.parse({
    nodes: truncated ? nodes.slice(0, WORKFLOW_WORKSPACE_LIMITS.maxNodes) : nodes,
    ...(truncated ? { truncated: true } : {}),
  });
}

/**
 * 一个工作区节点的正文，按 `maxBytes` 保形有界化（缺省与上限都是 resultMaxBytes，钳在这里）。
 * 授权全在宿主侧；宿主回 `undefined` = 无此节点 / 不是你的 run / 不是 world 行，归一成
 * 结构化的 not found。
 */

export async function workflowRunNodeResult(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunNodeResultResult> {
  const params = v4ConversationWorkflowRunNodeResultParamsSchema.parse(rawParams);
  if (!this.host.readDynamicWorkflowRunNodeResult) {
    throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", params.sessionId);
  }
  await this.ensureHostRecordForJournalRead(params.sessionId);
  const maxBytes = Math.max(
    1,
    Math.min(
      params.maxBytes ?? WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
      WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
    ),
  );
  const result = await this.host.readDynamicWorkflowRunNodeResult(params.sessionId, {
    runId: params.runId,
    siteId: params.siteId,
    ordinal: params.ordinal,
    maxBytes,
  });
  if (result === undefined) {
    throw new Error(
      `fault.workflowRunNodeResult.notFound: ${params.runId}/${params.siteId}@${params.ordinal}`,
    );
  }
  return v4ConversationWorkflowRunNodeResultResultSchema.parse(result);
}
