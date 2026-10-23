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

import type { ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";

import type {
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
  StableForkCandidateResolution,
} from "./product-projection-contract.js";

import type { ProductProjectionContext } from "./projection-context.js";
export function resolveEditTarget(
  this: ProductProjectionContext,
  rowId: number,
): ConversationEditTarget | null {
  if (!this.isLatestEditableUserRow(rowId)) return null;
  const entityId = this.entityIdByRowId.get(rowId);
  return entityId ? this.resolveEditTargetByEntityId(entityId) : null;
}

export function resolveEditTargetByEntityId(
  this: ProductProjectionContext,
  entityId: string,
): ConversationEditTarget | null {
  if (entityId !== this.currentEditableEntityId) return null;
  const target = this.editTargetByEntityId.get(entityId);
  return target ? { ...target, intent: { ...target.intent } } : null;
}

/**
 * V3 行动作的唯一解析器。展示 rowId 与稳定 entityId 必须同时命中当前 projection；
 * action 可用性直接读取同一次 materialization 生成的 row.actions，handler/preview
 * 不得再各自按位置、phase 或文本重算。
 */

export function resolveRowActionTarget(
  this: ProductProjectionContext,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
): ConversationRowTargetResolution {
  const row = this.findRow(target.rowId);
  if (!row || this.entityIdByRowId.get(target.rowId) !== target.entityId) {
    return { ok: false, status: "stale", reasonCode: "proto.staleTarget" };
  }
  if (action === "editUserQuery") {
    const editTarget = this.resolveEditTargetByEntityId(target.entityId);
    if (row.actions?.canEdit !== true || !row.actions.editDisposition || !editTarget) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, editTarget };
  }
  if (action === "retryTurn") {
    const messageId = this.messageIdByRowId.get(row.rowId);
    const userRow = this.snapshot.rows.window.find(
      (candidate) =>
        candidate.turnId === row.turnId &&
        candidate.kind === "userInput" &&
        candidate.origin === "realUser",
    );
    const userEntityId = userRow ? this.entityIdByRowId.get(userRow.rowId) : undefined;
    const editTarget = userEntityId ? this.editTargetByEntityId.get(userEntityId) : undefined;
    if (row.actions?.canRetry !== true || !messageId || !editTarget) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId, editTarget };
  }
  if (action === "forkAssistant") {
    const messageId = this.messageIdByRowId.get(row.rowId);
    if (row.actions?.canFork !== true || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (action === "setAssistantFeedback") {
    const messageId = this.messageIdByRowId.get(row.rowId);
    if (row.kind !== "assistantText" || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (action === "setHighspeedMetrics") {
    const messageId = this.messageIdByRowId.get(row.rowId);
    if (row.kind !== "userInput" || !row.highspeed || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (row.kind !== "turnHeader") {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    };
  }
  if (
    (action === "applyFileRewind" || action === "fileRewindPreview") &&
    (!row.fileChanges || row.actions?.canRewindFiles !== true)
  ) {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    };
  }
  return {
    ok: true,
    action,
    row,
    messageIds: this.getMessageIdsForTurnRow(row.rowId),
  };
}

/**
 * 文件摘要撤销以 turn rowId 为入口，服务端解析同一 product turn 内所有
 * messageId，覆盖多段 assistant / 多个 checkpoint；UI 不暴露内部 messageId。
 */

export function getMessageIdsForTurnRow(this: ProductProjectionContext, rowId: number): string[] {
  const row = this.findRow(rowId);
  if (!row) return [];
  const messageIds = new Set<string>();
  const runtimeTurnId = this.runtimeTurnIdByProductTurnId.get(row.turnId);
  // Bug 原因：model-only turn 不生成可见 userInput row，过去只扫描 row 会漏掉
  // checkpoint 使用的隐藏 user messageId。新 turn 有持久消息时 productTurnId
  // 就是该 messageId；把它作为精确锚点后无需扩大 runtime turn 的兜底范围。
  if (runtimeTurnId && runtimeTurnId !== row.turnId) {
    messageIds.add(row.turnId);
  }
  for (const candidate of this.snapshot.rows.window) {
    if (candidate.turnId !== row.turnId) continue;
    const messageId = this.messageIdByRowId.get(candidate.rowId);
    if (messageId) messageIds.add(messageId);
  }
  for (const [messageId, continuationRowId] of this.outputContinuationRowIdByMessageId) {
    const continuationRow = this.findRow(continuationRowId);
    if (continuationRow?.turnId === row.turnId) messageIds.add(messageId);
  }
  return [...messageIds];
}

/**
 * core 侧强校验：
 * rowId 是否为其所属 productTurn 的最后一段 assistantText。UI（平铺后）已只在
 * 最后段暴露 fork 入口，这里是防御闸——直接命令面/旧客户端不得 fork 中间段。
 */

export function isLatestAssistantSegmentRow(
  this: ProductProjectionContext,
  rowId: number,
): boolean {
  const row = this.findRow(rowId);
  if (row?.kind !== "assistantText") return false;
  for (let index = this.snapshot.rows.window.length - 1; index >= 0; index -= 1) {
    const candidate = this.snapshot.rows.window[index]!;
    if (candidate.kind === "assistantText" && candidate.turnId === row.turnId) {
      return candidate.rowId === rowId;
    }
  }
  return false;
}

/**
 * running fork 的同步投影闸门：这里只解析 row/product-turn 与 message 边界；完整
 * orderedMessageIds 由 host 再用 session store 权威顺序补齐并持久化 anchor。
 */

export function resolveStableForkCandidate(
  this: ProductProjectionContext,
  rowId: number,
): StableForkCandidateResolution {
  if (this.snapshot.control.activeWorks.some((work) => work.kind === "compact")) {
    return { ok: false, reasonCode: "guard.compactOperationLock" };
  }
  const row = this.findRow(rowId);
  if (row?.kind !== "assistantText") {
    return { ok: false, reasonCode: "guard.forkAssistantOnly" };
  }
  const headerRowId = this.turnHeaderRowIdByTurnId.get(row.turnId);
  const header = headerRowId === undefined ? undefined : this.findRow(headerRowId);
  if (
    row.state !== "complete" ||
    row.actions?.canFork !== true ||
    header?.kind !== "turnHeader" ||
    header.state !== "completedSuccess" ||
    !this.isLatestAssistantSegmentRow(rowId)
  ) {
    return { ok: false, reasonCode: "guard.forkTargetNotStable" };
  }
  const boundaryMessageId = this.messageIdByRowId.get(rowId);
  if (!boundaryMessageId) {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  const startMessageId =
    this.snapshot.rows.window
      .filter((candidate) => candidate.turnId === row.turnId && candidate.kind === "userInput")
      .map((candidate) => this.messageIdByRowId.get(candidate.rowId))
      .find((messageId): messageId is string => Boolean(messageId)) ?? null;
  return {
    ok: true,
    candidate: {
      productTurnId: row.turnId,
      transcriptTurnId: this.runtimeTurnIdByProductTurnId.get(row.turnId) ?? row.turnId,
      startMessageId,
      boundaryMessageId,
    },
  };
}

/** latestAssistantRetryOnly：retry 只能指向全时间线最新且有 realUser cause 的 assistantText。 */

export function isLatestRetryAssistantRow(this: ProductProjectionContext, rowId: number): boolean {
  const row = this.findRow(rowId);
  return Boolean(
    row?.kind === "assistantText" &&
    row.actions?.canRetry === true &&
    this.messageIdByRowId.has(rowId),
  );
}

/** latestQueryEditOnly：只有当前投影里的最后一条 realUser userInput row 可 edit。 */

export function isLatestEditableUserRow(this: ProductProjectionContext, rowId: number): boolean {
  const row = this.findRow(rowId);
  return Boolean(
    row?.kind === "userInput" &&
    row.origin === "realUser" &&
    row.actions?.canEdit === true &&
    this.messageIdByRowId.has(rowId),
  );
}

/** rowId → product turnId（命令层 running edit 在无 assistant anchor 时回查 store 用）。 */

export function getTurnIdForRow(this: ProductProjectionContext, rowId: number): string | null {
  return this.findRow(rowId)?.turnId ?? null;
}

/**
 * 任意 rowId → 其所属 turn 的 rewind 锚点 messageId。新 live/cold user row 都应
 * 直接携持久 user messageId；同 turn assistant 只保留为旧事件兼容 fallback。
 * `canEdit` 不允许依赖该 fallback，必须由 user row 自身的 exact target 驱动。
 */

export function getTurnRewindAnchor(this: ProductProjectionContext, rowId: number): string | null {
  return this.rewindAnchorForRows(this.snapshot.rows.window, rowId);
}

/**
 * real-user row 的展示身份与命令身份必须原子登记。
 * TurnSteerDrained 曾只写 messageId/entityId，漏写 edit target，
 * 导致 UI action 与 editUserQuery resolver 对同一行得出相反结论。
 */

export function registerCanonicalUserRowTarget(
  this: ProductProjectionContext,
  rowId: number,
  entityId: string,
  editTarget?: ConversationEditTarget,
): void {
  this.entityIdByRowId.set(rowId, entityId);
  if (!editTarget) return;
  this.messageIdByRowId.set(rowId, editTarget.transcriptMessageId);
  this.editTargetByEntityId.set(entityId, editTarget);
}
