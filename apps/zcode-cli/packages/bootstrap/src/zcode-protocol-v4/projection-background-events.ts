// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type { DynamicWorkflowRunProgressPayload, SessionEvent } from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）
import { resolveZCodeBackgroundTaskControlKind } from "@zcode/shared";

import type {
  BackgroundWorkSummary,
  ConversationDelta,
  SubagentRow,
  WorkflowRunProgressEnvelope,
} from "@zcode/shared/zcode-protocol-v4";

import { diffWorkflowRunsState, reduceWorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";

import type { ProductProjectionContext } from "./projection-context.js";
export function resumedSubagentBackgroundWorkDelta(
  this: ProductProjectionContext,
  event: SessionEvent,
  payload: Record<string, unknown>,
  agentId: string,
  childSessionId: string | undefined,
): ConversationDelta | undefined {
  if (payload.background !== true || payload.resumed !== true || !childSessionId) {
    return undefined;
  }

  // SendMessage resume 直接进入 subagent port，不经过 Agent tool executor，
  // 因而不会产生 tracker 的 BackgroundTaskStarted。SubagentSpawned 已是单一启动事实，
  // 这里在同一次 V4 transaction 内补齐可取消 work，避免再引入第二个可失败事件。
  const previous = this.snapshot.backgroundWorks;
  const existing = previous.find((work) => work.workId === agentId);
  const title =
    this.stringPayload(payload, "description") ??
    this.stringPayload(payload, "prompt") ??
    existing?.title ??
    agentId;
  if (
    existing?.status === "running" &&
    existing.kind === "subagent" &&
    existing.title === title &&
    existing.childSessionId === childSessionId &&
    existing.cancellable === true
  ) {
    return undefined;
  }
  const next: BackgroundWorkSummary = {
    workId: agentId,
    kind: "subagent",
    title,
    status: "running",
    startedAt: this.ms(event),
    cancellable: true,
    anchorRowId: existing?.anchorRowId ?? null,
    childSessionId,
  };
  const backgroundWorks = existing
    ? previous.map((work) => (work.workId === agentId ? next : work))
    : [...previous, next];
  return { op: "state.updated", patch: { backgroundWorks } };
}

export function onSubagentMessage(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const row = this.findSubagentRow(this.subagentAgentId(payload, event));
  const append =
    this.stringPayload(payload, "summaryText") ??
    this.stringPayload(payload, "text") ??
    this.stringPayload(payload, "message");
  if (!row || !append) return [];
  return [{ op: "row.delta", rowId: row.rowId, path: "summaryText", append }];
}

export function onSubagentStopped(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const agentId = this.subagentAgentId(payload, event);
  const existing = this.findSubagentLifecycleRow(agentId, payload, event);
  const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
  const status = this.mapSubagentStatus(this.stringPayload(payload, "status"));
  const summaryText =
    this.stringPayload(payload, "summaryText") ??
    this.stringPayload(payload, "result") ??
    this.stringPayload(payload, "error") ??
    this.stringPayload(payload, "description") ??
    existing?.summaryText ??
    "";
  const row: SubagentRow = existing
    ? {
        ...existing,
        status,
        summaryText,
        endedAt: this.ms(event),
        // resumed child 的终态同样属于原 Agent row，只在旧 row 缺失锚点时补齐。
        ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
        ...(this.stringPayload(payload, "childSessionId")
          ? { childSessionId: this.stringPayload(payload, "childSessionId") }
          : {}),
      }
    : {
        ...this.rowBase(event, this.turnIdOf(event), agentId),
        kind: "subagent",
        ...(this.stringPayload(payload, "parentToolCallId")
          ? {
              parentToolCallId: this.stringPayload(payload, "parentToolCallId"),
            }
          : {}),
        subagentType: this.stringPayload(payload, "agentType") ?? "subagent",
        status,
        summaryText,
        ...(this.stringPayload(payload, "childSessionId")
          ? { childSessionId: this.stringPayload(payload, "childSessionId") }
          : {}),
        ...(payload.background === true ? { backgrounded: true as const } : {}),
        ...(payload.background === true ? { workId: agentId } : {}),
        endedAt: this.ms(event),
      };
  this.subagentRowIdByAgentId.set(agentId, row.rowId);
  return [{ op: existing ? "row.upserted" : "row.appended", row }];
}

// cancelBackgroundWork：后台任务生命周期（BackgroundTaskStarted/Updated/Completed）
// → 维护 snapshot.backgroundWorks（后台工作面读它渲染 + cancel 入口）。
// taskId≡workId 无需翻译；status 归一到 summary 的 4 值封闭枚举。

export function onBackgroundTaskLifecycle(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    taskId?: string;
    toolName?: string;
    taskKind?: string;
    command?: string;
    description?: string;
    status?: string;
    cancellable?: boolean;
    blocked?: boolean;
    childSessionId?: string;
  };
  const workId = payload.taskId;
  if (!workId) return [];
  const prev = this.snapshot.backgroundWorks;
  const existing = prev.find((work) => work.workId === workId);
  const legacyKind = resolveZCodeBackgroundTaskControlKind(payload);
  // 新事件使用 runtime 的显式 taskKind；旧事件统一走 shared resolver，
  // 不能再在 reducer 内散落 Agent/Task/subagent 字符串分支。
  // "workflow" 是 workflow run（此前错标成 bash）；legacy resolver 里没有对应值，因为
  // legacy `Workflow` 工具刻意仍归 bash——两者是不同的东西，共用类别会让面板混在一起。
  const kind: BackgroundWorkSummary["kind"] =
    payload.taskKind === "subagent"
      ? "subagent"
      : payload.taskKind === "bash"
        ? "bash"
        : payload.taskKind === "workflow"
          ? "workflow"
          : legacyKind === "agent"
            ? "subagent"
            : legacyKind === "bash"
              ? "bash"
              : (existing?.kind ?? "bash");
  // 事件 status（running/completed/failed/timed_out/cancelled/spawn_error/lost）
  // → summary status（running/resultPending/failed/cancelled）。
  const rawStatus = payload.status ?? "running";
  const status: "running" | "resultPending" | "failed" | "cancelled" =
    rawStatus === "running"
      ? "running"
      : rawStatus === "cancelled"
        ? "cancelled"
        : rawStatus === "completed"
          ? "resultPending"
          : "failed";
  const title =
    payload.description?.trim() ||
    payload.command?.trim() ||
    existing?.title ||
    payload.toolName ||
    workId;
  const next: BackgroundWorkSummary = {
    workId,
    kind,
    title,
    status,
    startedAt: existing?.startedAt ?? this.ms(event),
    ...(status === "running" ? {} : { endedAt: this.ms(event) }),
    ...(typeof payload.cancellable === "boolean"
      ? { cancellable: payload.cancellable }
      : existing?.cancellable !== undefined
        ? { cancellable: existing.cancellable }
        : {}),
    ...(typeof payload.blocked === "boolean"
      ? { blocked: payload.blocked }
      : existing?.blocked !== undefined
        ? { blocked: existing.blocked }
        : {}),
    anchorRowId: existing?.anchorRowId ?? null,
    ...(payload.childSessionId
      ? { childSessionId: payload.childSessionId }
      : existing?.childSessionId
        ? { childSessionId: existing.childSessionId }
        : {}),
  };
  // 幂等：内容无变化不产 delta。
  if (
    existing &&
    existing.status === next.status &&
    existing.title === next.title &&
    existing.kind === next.kind &&
    existing.cancellable === next.cancellable &&
    existing.blocked === next.blocked &&
    existing.childSessionId === next.childSessionId
  ) {
    return [];
  }
  const backgroundWorks = existing
    ? prev.map((work) => (work.workId === workId ? next : work))
    : [...prev, next];
  return [{ op: "state.updated", patch: { backgroundWorks } }];
}

// ── dwf 实时运行态：DynamicWorkflowRunProgress → workflowRuns 状态键 ──
// 一条引擎 RunEvent 一条会话事件，归约成键级整体替换的权威态。走 reducer 而不是侧通道，
// 所以持久、可回放、冷恢复免费（先例：subagents 键）。
//
// 归约本体在 @zcode/shared 的 workflow-runs-reducer（与状态 schema 同居）：TUI 镜像要用
// 同一份归约，两处各写一份就是两个时钟（docs/dynamic-workflow/launch.md「The inline card」）。
// 留在这里的只有投影的非纯部分——从事件信封取载荷、把新旧状态之差发成键级增量。

export function onDynamicWorkflowRunProgress(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  // 先转 contracts 的有界 payload、再赋给 shared 的结构化入参：这行赋值就是"两边形状不漂移"
  // 的编译期闸（shared 不得反向依赖 contracts，所以入参类型只能结构化定义）。
  const envelope: WorkflowRunProgressEnvelope = event.payload as DynamicWorkflowRunProgressPayload;
  const prior = this.snapshot.workflowRuns;
  const workflowRuns = reduceWorkflowRunsState(prior, envelope);
  // null = 语义无变化（无效事件或同一条事件重放）：不产 delta，revision 不抬。
  if (workflowRuns === null) return [];
  // 发**差**而不是整键：一条引擎事件只动一个节点，整键重发是每事件 O(N) 字节、一条 run
  // 全程 O(N²)（workflow-runs-delta.ts 的文件头讲了这笔账怎么变成节点上界和 UI 卡死的）。
  // `applyAll(prior, diff(prior, next))` 与 next **逐字节**一致是被 property 测试钉住的契约，
  // 所以 applyEventInternal 把这串 delta 应用回去之后，this.snapshot.workflowRuns 仍是 next。
  return diffWorkflowRunsState(prior, workflowRuns);
}
