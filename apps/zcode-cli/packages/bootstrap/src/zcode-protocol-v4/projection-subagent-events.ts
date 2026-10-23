// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type { SessionEvent } from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）

import type {
  ConversationDelta,
  ConversationRow,
  RunningSubagentSummary,
  SubagentProjectionState,
  SubagentRow,
} from "@zcode/shared/zcode-protocol-v4";

import type { ProductProjectionContext } from "./projection-context.js";
/**
 * Subagent row 与摘要投影在同一个 event transaction 内 materialize。
 * 旧 UI 在 spawn 后另查 session/subagents；7 个并发 child 中查询若恰好落在
 * 最后一个 session 持久化前，就会永久缓存 6，直到切换 Session 才重查。现在 renderer
 * 只消费这里随 row 一起提交的完整态，不再存在事件/查询双时钟。
 */

export function shouldMaterializeSubagentProjection(
  this: ProductProjectionContext,
  reduced: readonly ConversationDelta[],
): boolean {
  // 性能问题根因：cold hydration 曾让 checkpoint 等无关事件也扫描全部历史 rows。
  // 这里只在尚未发布的 batch accumulator 内按 materializer 的真实输入准入；live 与
  // strict fallback 仍走原路径，batch 之后直接写权威 manifest 的 store seed 不受影响。
  if (!this.hydrationAccumulator) return true;

  for (const delta of reduced) {
    switch (delta.op) {
      case "row.appended":
      case "row.upserted":
        if (delta.row.kind === "subagent" || this.findRow(delta.row.rowId)?.kind === "subagent") {
          return true;
        }
        break;
      case "row.delta":
        if (this.findRow(delta.rowId)?.kind === "subagent") return true;
        break;
      case "row.removed":
        // 后缀删除可能同时移除 subagent row；不为判定再预扫描一次 rows。
        return true;
      case "state.updated":
        if (
          delta.patch.pendingInteractions !== undefined ||
          delta.patch.backgroundWorks !== undefined
        ) {
          return true;
        }
        break;
      case "pluginUi.resourceUpdated":
      case "pluginUi.resourceListChanged":
      case "pluginUi.instanceClosed":
      case "pluginUi.appToolCall":
      // 非行 op：只动 workflowRuns 状态键，与 subagent 行投影的输入没有交集。
      case "workflowRun.updated":
      case "workflowRun.removed":
        break;
      default: {
        const exhaustiveDelta: never = delta;
        return exhaustiveDelta;
      }
    }
  }
  return false;
}

export function materializeSubagentProjection(
  this: ProductProjectionContext,
  reduced: readonly ConversationDelta[],
): ConversationDelta[] {
  const previous: SubagentProjectionState = this.snapshot.subagents ?? {
    revision: 0,
    childSessionIds: [],
    running: [],
    endedTotal: 0,
  };
  const previousRunningById = new Map(previous.running.map((item) => [item.childSessionId, item]));
  const latestRowByChildId = new Map<string, SubagentRow>();
  const collectSubagentRow = (row: SubagentRow | null): void => {
    if (row?.childSessionId && !this.invalidSubagentChildSessionIds.has(row.childSessionId)) {
      latestRowByChildId.set(row.childSessionId, row);
    }
  };
  // 性能问题根因：旧实现先复制完整 rows 数组，再扫描所有普通 conversation rows。
  // subagentRowIdByAgentId 已是 reducer 查找用的派生索引；这里按 rowId 去重，并通过
  // rowIndexById 恢复当前时间线顺序；row.removed 应用后会清理已失效的 alias。
  const currentRowIds = new Set(this.subagentRowIdByAgentId.values());
  for (const delta of reduced) {
    if (delta.op === "row.upserted") {
      if (delta.row.kind === "subagent" || this.findRow(delta.row.rowId)?.kind === "subagent") {
        currentRowIds.add(delta.row.rowId);
      }
    } else if (delta.op === "row.delta" && this.findRow(delta.rowId)?.kind === "subagent") {
      currentRowIds.add(delta.rowId);
    }
  }
  const currentRows: Array<{ rowIndex: number; row: ConversationRow }> = [];
  for (const rowId of currentRowIds) {
    const rowIndex = this.rowIndexById.get(rowId);
    const row = rowIndex === undefined ? undefined : this.snapshot.rows.window[rowIndex];
    if (rowIndex !== undefined && row !== undefined) currentRows.push({ rowIndex, row });
  }
  currentRows.sort((left, right) => left.rowIndex - right.rowIndex);
  for (const { row } of currentRows) {
    collectSubagentRow(this.prospectiveSubagentRow(row, reduced, 0));
  }
  for (let index = 0; index < reduced.length; index += 1) {
    const delta = reduced[index]!;
    if (delta.op !== "row.appended") continue;
    collectSubagentRow(this.prospectiveSubagentRow(delta.row, reduced, index + 1));
  }

  let pendingInteractions = this.snapshot.pendingInteractions;
  let backgroundWorks = this.snapshot.backgroundWorks;
  for (const delta of reduced) {
    if (delta.op !== "state.updated") continue;
    if (delta.patch.pendingInteractions !== undefined) {
      pendingInteractions = delta.patch.pendingInteractions;
    }
    if (delta.patch.backgroundWorks !== undefined) {
      backgroundWorks = delta.patch.backgroundWorks;
    }
  }
  const waitingChildIds = new Set<string>();
  // workspace-hook-trust 新增的 hook review 交互 payload 没有 origin 字段，跳过守卫避免误读。
  for (const interaction of pendingInteractions) {
    if (!("origin" in interaction.payload)) continue;
    const origin = interaction.payload.origin;
    if (origin?.kind === "subagent") waitingChildIds.add(origin.childSessionId);
  }
  const blockedChildIds = new Set(
    backgroundWorks.flatMap((work) =>
      work.kind === "subagent" && work.status === "running" && work.blocked && work.childSessionId
        ? [work.childSessionId]
        : [],
    ),
  );

  const childSessionIds = [...latestRowByChildId.keys()];
  const running: RunningSubagentSummary[] = [];
  for (const [childSessionId, row] of latestRowByChildId) {
    if (row.status !== "running") continue;
    const previousItem = previousRunningById.get(childSessionId);
    const title = previousItem?.title || row.summaryText.trim() || row.subagentType;
    running.push({
      childSessionId,
      agentId: row.entityId,
      ...(row.parentToolCallId ? { toolCallId: row.parentToolCallId } : {}),
      subagentType: row.subagentType,
      title,
      status: waitingChildIds.has(childSessionId)
        ? "waiting"
        : blockedChildIds.has(childSessionId)
          ? "blocked"
          : "running",
      ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  const endedTotal = childSessionIds.length - running.length;
  const semanticState = { childSessionIds, running, endedTotal };
  if (
    JSON.stringify(semanticState) ===
    JSON.stringify({
      childSessionIds: previous.childSessionIds,
      running: previous.running,
      endedTotal: previous.endedTotal,
    })
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: {
        subagents: {
          revision: previous.revision + 1,
          ...semanticState,
        },
      },
    },
  ];
}

export function prospectiveSubagentRow(
  this: ProductProjectionContext,
  row: ConversationRow,
  reduced: readonly ConversationDelta[],
  startIndex: number,
): SubagentRow | null {
  let prospective: ConversationRow | null = row;
  for (let index = startIndex; index < reduced.length && prospective; index += 1) {
    const delta = reduced[index]!;
    switch (delta.op) {
      case "row.appended":
      case "state.updated":
      case "pluginUi.resourceUpdated":
      case "pluginUi.resourceListChanged":
      case "pluginUi.instanceClosed":
      case "pluginUi.appToolCall":
      // 非行 op：改不了这一行的 prospective 形态。
      case "workflowRun.updated":
      case "workflowRun.removed":
        break;
      case "row.upserted":
        if (delta.row.rowId === prospective.rowId) prospective = delta.row;
        break;
      case "row.delta":
        if (
          delta.rowId === prospective.rowId &&
          delta.path === "summaryText" &&
          prospective.kind === "subagent"
        ) {
          prospective = {
            ...prospective,
            summaryText: prospective.summaryText + delta.append,
          };
        }
        break;
      case "row.removed":
        if (prospective.rowId >= delta.fromRowId) prospective = null;
        break;
      default: {
        const exhaustiveDelta: never = delta;
        return exhaustiveDelta;
      }
    }
  }
  return prospective?.kind === "subagent" ? prospective : null;
}

// ── subagent 行镜像──
// schema/UI 已有 subagent row，但旧 reducer 未消费 Subagent* 事件；
// cold hydration 即使合成事件也无法恢复下钻行。这里让 live/cold 共用同一状态机。

export function onSubagentSpawned(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const agentId = this.subagentAgentId(payload, event);
  const existing = this.findSubagentLifecycleRow(agentId, payload, event);
  if (existing) this.subagentRowIdByAgentId.set(agentId, existing.rowId);
  const childSessionId = this.stringPayload(payload, "childSessionId");
  const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
  const resumedBackgroundWork = this.resumedSubagentBackgroundWorkDelta(
    event,
    payload,
    agentId,
    childSessionId,
  );
  if (
    existing?.status === "running" &&
    (!childSessionId || childSessionId === existing.childSessionId) &&
    (!parentToolCallId || parentToolCallId === existing.parentToolCallId) &&
    (payload.background !== true || existing.backgrounded === true)
  ) {
    return resumedBackgroundWork ? [resumedBackgroundWork] : [];
  }
  if (existing) {
    const row: SubagentRow = {
      ...existing,
      status: "running",
      summaryText:
        this.stringPayload(payload, "description") ??
        this.stringPayload(payload, "prompt") ??
        existing.summaryText,
      // resume 事件携带的是 SendMessage call id，但 parentToolCallId 是 row 的创建锚点；
      // 已存在的锚点不能作为生命周期字段被覆盖，否则 UI 无法再关联原 Agent 行。
      ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      ...(payload.background === true ? { backgrounded: true as const } : {}),
      ...(payload.background === true ? { workId: agentId } : {}),
      startedAt: this.ms(event),
    };
    delete row.endedAt;
    return [{ op: "row.upserted", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
  }
  const row: SubagentRow = {
    ...this.rowBase(event, this.turnIdOf(event), agentId),
    kind: "subagent",
    ...(this.stringPayload(payload, "parentToolCallId")
      ? { parentToolCallId: this.stringPayload(payload, "parentToolCallId") }
      : {}),
    subagentType: this.stringPayload(payload, "agentType") ?? "subagent",
    status: "running",
    summaryText:
      this.stringPayload(payload, "description") ??
      this.stringPayload(payload, "summaryText") ??
      this.stringPayload(payload, "prompt") ??
      "",
    ...(this.stringPayload(payload, "childSessionId")
      ? { childSessionId: this.stringPayload(payload, "childSessionId") }
      : {}),
    ...(payload.background === true ? { backgrounded: true as const } : {}),
    ...(payload.background === true ? { workId: agentId } : {}),
    startedAt: this.ms(event),
  };
  this.subagentRowIdByAgentId.set(agentId, row.rowId);
  return [{ op: "row.appended", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
}
