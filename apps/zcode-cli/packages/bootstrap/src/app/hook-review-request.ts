import { SessionEventType, type WorkspaceHookBundleSnapshot } from "@zcode/contracts";

import { type WorkspaceHookReviewFlow, type WorkspaceHookSnapshotEvaluation } from "@zcode/core";

import type { WorkspaceHookReviewRequestPayload } from "@zcode/shared/zcode-protocol-v4";

import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-types.js";

import {
  buildWorkspaceHookReviewRequest,
  toWorkspaceHookReviewTarget,
} from "./workspace-hook-review-request.js";

import { superviseWorkspaceHookReviewFlow } from "./workspace-hook-review-supervisor.js";

import type { WorkspaceHookReviewControllerMethodsContext } from "./hook-review-context.js";
/**
 * 见 workspace-hook-review-supervisor：任何新开 flow 都必须交由它监管。
 *
 * openOrReuseFlow 会复用仍 pending 的同一 flow
 * 对象，因此重复 requestReview 与 revoke 重开路径可能给同一个 flow 各挂一个 supervisor，
 * timeout 时重复 emit ReviewSettled。重复监管与缺监管同病：
 * 按 flow 对象单例化，重复请求直接复用已有的监管 promise。
 */

export function superviseFlow(
  this: WorkspaceHookReviewControllerMethodsContext,
  flow: WorkspaceHookReviewFlow,
): Promise<void> {
  const existing = this.supervisedFlows.get(flow);
  if (existing) return existing;
  const supervision = superviseWorkspaceHookReviewFlow({
    flow,
    host: this.host,
    registry: this.registry,
    sessionId: this.sessionId,
    telemetry: this.telemetry,
  });
  this.supervisedFlows.set(flow, supervision);
  return supervision;
}

/**
 * 软门禁:按需开审核 flow。
 *
 * 用户点击「去审核」时经 requestWorkspaceHookReview 命令调用。
 * 无 pending 项时为安全 no-op(返回 accepted)。
 * 已有活跃 flow 时幂等复用(openOrReuseFlow)。
 * 必须经 superviseFlow 监管——否则 flow 超时后会静默死亡、面板永久失效。
 */

export async function requestReview(
  this: WorkspaceHookReviewControllerMethodsContext,
  target: {
    workspaceIdentity: string;
    bundleDigest: string;
  },
): Promise<WorkspaceHookReviewCommandResult> {
  const snapshot = this.admission.getCurrentSnapshot();
  if (
    target.workspaceIdentity !== snapshot.workspaceIdentity ||
    target.bundleDigest !== snapshot.bundleDigest
  ) {
    return {
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch" as const,
    };
  }
  const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
  // 旧实现只把 configuredEnabled=true 的 pending 当成可审核项，导致
  // Settings 把未信任开关锁定后形成死锁——disabled Hook 不会运行、不会触发 Banner，
  // 也永远无法预先建立 Trust。配置 gate 与 Trust 正交；review request 本就携带全部
  // snapshot items，因此按 admissionClass 判断即可，disabled item 信任后仍不会运行。
  const hasPending = evaluation.items.some((item) => item.admissionClass === "pending");
  if (!hasPending) {
    if (evaluation.items.some((item) => item.trustState === "blocked_policy")) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_blocked_by_policy" as const,
      };
    }
    if (evaluation.storeStatus === "corrupt") {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_trust_store_corrupt" as const,
      };
    }
    // 无待审项:安全 no-op
    return { accepted: true, reviewItemIds: [] };
  }
  const flow = await this.openOrReuseFlow(snapshot, evaluation);
  void this.superviseFlow(flow).catch(() => undefined);
  return { accepted: true, reviewItemIds: [] };
}

export async function refreshPendingFlow(
  this: WorkspaceHookReviewControllerMethodsContext,
  snapshot: WorkspaceHookBundleSnapshot,
): Promise<WorkspaceHookReviewFlow | undefined> {
  const current = this.registry.getCurrentFlow(this.sessionId);
  if (!current || current.state.state !== "pending") {
    // 无 pending flow 时直接返回会让
    // 「授权 → review resolved → 撤销」之后，当前会话再没有任何重新授权入口，
    // 用户只能新建对话。
    //
    // revoke 的语义是 revoked → admission=pending，本就应重新征询，
    // 因此这里在确实产生了待审项时开启新 flow：不新增「直接授予信任」的旁路，
    // 授权仍只能经当前不可变 review 绑定的行内按钮完成。
    return await this.openReviewFlowForNewPendingItems(snapshot);
  }
  const target = toWorkspaceHookReviewTarget(current.request);
  const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
  const replacement = this.buildRequest(snapshot, evaluation, {
    reviewFlowId: current.request.reviewFlowId,
    generation: current.request.generation + 1,
  });
  const nextFlow = this.registry.supersede(target, replacement);
  this.telemetry.superseded(replacement);
  this.generation = replacement.generation;
  await this.host.emit({
    type: SessionEventType.WorkspaceHookReviewSuperseded,
    payload: {
      interactionId: current.request.interactionId,
      supersededByInteractionId: replacement.interactionId,
    },
  });
  this.telemetry.requestCreated(replacement);
  await this.host.emit({
    type: SessionEventType.WorkspaceHookReviewRequested,
    payload: { request: replacement },
  });
  if (replacement.summary.pendingCount === 0) {
    this.registry.closeWithoutDecision(toWorkspaceHookReviewTarget(replacement));
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewSettled,
      payload: {
        interactionId: replacement.interactionId,
        state: "resolved",
      },
    });
  }
  return nextFlow;
}

/**
 * revoke 之后当前会话没有 pending flow 时，重新开启审核。
 *
 * 只在真的存在待审项时开启。开关只控制运行，信任只控制准入；因此当前审核
 * 快照中的 configured-disabled 声明也必须保留行内信任入口。开启走
 * openOrReuseFlow，与首次征询同一条路径，因此 generation / reviewFlowId /
 * interactionId 的既有语义不变。
 */

export async function openReviewFlowForNewPendingItems(
  this: WorkspaceHookReviewControllerMethodsContext,
  snapshot: WorkspaceHookBundleSnapshot,
): Promise<WorkspaceHookReviewFlow | undefined> {
  const evaluation = this.coordinator.evaluateSnapshot({
    snapshot,
  });
  const hasPending = evaluation.items.some((item) => item.admissionClass === "pending");
  if (!hasPending) return undefined;
  const flow = await this.openOrReuseFlow(snapshot, evaluation);
  // 必须监管：否则该 flow 超时后静默死亡，面板永久失效（见 superviseFlow 注释）。
  // 这里刻意不 await——revoke 命令不能被 10 分钟的审核 deadline 阻塞；
  // catch 兜底避免未处理拒绝，flow 终结本身不产生需要向调用方冒泡的错误。
  void this.superviseFlow(flow).catch(() => undefined);
  return flow;
}

export async function openOrReuseFlow(
  this: WorkspaceHookReviewControllerMethodsContext,
  snapshot: WorkspaceHookBundleSnapshot,
  evaluation: WorkspaceHookSnapshotEvaluation,
): Promise<WorkspaceHookReviewFlow> {
  const current = this.registry.getCurrentFlow(this.sessionId);
  if (
    current?.state.state === "pending" &&
    current.request.bundleDigest === snapshot.bundleDigest
  ) {
    return current;
  }
  this.reviewFlowId ??= `workspace-hook-review:${this.createId()}`;
  const request = this.buildRequest(snapshot, evaluation, {
    reviewFlowId: this.reviewFlowId,
    generation: this.generation + 1,
  });
  this.generation = request.generation;
  const flow = this.registry.open(request);
  this.telemetry.requestCreated(request);
  await this.host.emit({
    type: SessionEventType.WorkspaceHookReviewRequested,
    payload: { request },
  });
  return flow;
}

export function buildRequest(
  this: WorkspaceHookReviewControllerMethodsContext,
  snapshot: WorkspaceHookBundleSnapshot,
  evaluation: WorkspaceHookSnapshotEvaluation,
  flow: { reviewFlowId: string; generation: number },
): WorkspaceHookReviewRequestPayload {
  return buildWorkspaceHookReviewRequest({
    snapshot,
    evaluation,
    ...flow,
    sessionId: this.sessionId,
    host: this.host,
    now: this.now,
    createId: this.createId,
  });
}
