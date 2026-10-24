import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  type BackgroundBashOutputResult,
} from "@zcode/shared/zcode-protocol-v4";

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
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";

import {
  v4ConversationFileChangesParamsSchema,
  v4ConversationFileRewindPreviewParamsSchema,
  v4ConversationRowsRangeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";

import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

import { toRuntimeTurnId } from "./gateway-support.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
/**
 * v4/conversation/rowsRange：按 beforeRowId 游标向上取一窗
 * 历史行。只读 query，不建订阅；数据源 = 该会话投影全量行——冷会话（重启后直开
 * 历史）复用与 subscribe 相同的冷恢复 + hydration 管线先把投影建起来。
 */

export async function rowsRange(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4ConversationRowsRangeResult> {
  const params = v4ConversationRowsRangeParamsSchema.parse(rawParams);
  const existingReady = this.readyFlights.get(params.sessionId);
  const publisher = this.historyOpenings.has(params.sessionId)
    ? await this.historyOpenings.get(params.sessionId)!.history
    : this.publishers.get(params.sessionId)?.getSnapshot().runtimeInitialization?.status ===
        "failed"
      ? this.publishers.get(params.sessionId)!
      : existingReady
        ? await existingReady
        : !this.hasLiveConversation(params.sessionId)
          ? await this.ensureColdReadyPublisher(params.sessionId)
          : await this.hydratePublisher(params.sessionId);
  return publisher.getRowsRange(
    {
      ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
      limit: params.limit,
    },
    // clientMode 决定行可见性过滤档位：桌面 continuous（默认）/ 断线恢复 replayable。
    params.clientMode === "desktop-continuous" ? "continuous" : "replayable",
  );
}

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

export async function ensureHostRecordForJournalRead(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
): Promise<void> {
  const ready = this.readyFlights.get(sessionId);
  if (ready) await ready;
  if (this.publishers.get(sessionId)?.getSnapshot().runtimeInitialization?.status === "failed")
    throw new Error("fault.subscribe.resumeFailed");
  if (this.hasLiveConversation(sessionId)) return;
  await this.coldResume.ensureResumed(sessionId);
}

export async function fileChanges(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4ConversationFileChangesResult> {
  const params = v4ConversationFileChangesParamsSchema.parse(rawParams);
  if (!this.host.getConversationFileChanges) {
    throw new Error("fault.fileChanges.unsupported");
  }
  const existingReady = this.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !this.hasLiveConversation(params.sessionId)
      ? await this.ensureColdReadyPublisher(params.sessionId)
      : await this.hydratePublisher(params.sessionId);
  const resolution = this.resolveQueryRowTarget(publisher, params, "fileChanges");
  const messageIds = resolution.messageIds ?? [];
  const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
  return this.host.getConversationFileChanges(
    params.sessionId,
    params.target.rowId,
    messageIds,
    targetTurnId,
  );
}

export async function backgroundBashOutput(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<BackgroundBashOutputResult> {
  const { sessionId, workId } = v4BackgroundBashOutputParamsSchema.parse(rawParams);
  // 观察查询不能 hydrate/恢复冷会话；任务由现有 runtime 授权。
  if (!this.host.readBackgroundBashOutput) return { kind: "unsupported", workId };
  return backgroundBashOutputResultSchema.parse(
    await this.host.readBackgroundBashOutput(sessionId, workId),
  );
}

export async function fileRewindPreview(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4ConversationFileRewindPreviewResult> {
  const params = v4ConversationFileRewindPreviewParamsSchema.parse(rawParams);
  if (!this.host.previewConversationFileRewind) {
    throw new Error("fault.fileRewindPreview.unsupported");
  }
  const existingReady = this.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !this.host.sessionExists(params.sessionId)
      ? await this.ensureColdReadyPublisher(params.sessionId)
      : await this.hydratePublisher(params.sessionId);
  const resolution = this.resolveQueryRowTarget(publisher, params, "fileRewindPreview");
  const messageIds = resolution.messageIds ?? [];
  const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
  return this.host.previewConversationFileRewind(
    params.sessionId,
    params.target.rowId,
    messageIds,
    targetTurnId,
  );
}

export function resolveQueryRowTarget(
  this: ConversationV4GatewayMethodsContext,
  publisher: ConversationTopicPublisher,
  params: {
    target: ConversationRowTarget;
    baseRevision: number;
    baseLogEpoch: string;
  },
  action: "fileChanges" | "fileRewindPreview",
): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }> {
  const snapshot = publisher.getSnapshot();
  if (params.baseLogEpoch !== snapshot.logEpoch) throw new Error("proto.staleLogEpoch");
  if (params.baseRevision !== snapshot.revision) throw new Error("proto.staleRevision");
  const resolution = publisher.resolveRowActionTarget(params.target, action);
  if (!resolution.ok) throw new Error(resolution.reasonCode);
  return resolution;
}
