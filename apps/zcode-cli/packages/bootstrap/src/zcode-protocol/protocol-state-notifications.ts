import { type ZCodeStateUpdatedNotification } from "@zcode/shared";
import {
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { ensureSessionModelAvailable } from "./workspace-model-runtime.js";
import { snapshot } from "./protocol-session-snapshot.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
/**
 * 纯配置类 mutation reason：只改会话选型，不算用户活动。
 * 与 isConfigOnlySessionEvent 同一裁决——record.updatedAt 是 sessions-index
 * lastActivityAt / snapshot.session.updatedAt（task index 排序时间）的事实源，
 * 切模型/切思考深度/切模式不能把任务顶到列表最前。
 */
const CONFIG_ONLY_MUTATION_REASONS = new Set([
  "model_changed",
  "thought_level_changed",
  "mode_changed",
]);

export async function afterStateMutation(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  if (!record.activeAbortController) {
    // provider registry 可能在 turn 运行中删除当前模型。更新时不能改写在途请求；turn/compact/
    // goal continuation 释放 active lock 后统一经过此安全边界，立即完成同一 Agent fallback，
    // 无需等待用户下一次发送，也不把兜底职责重新交给 renderer。
    await ensureSessionModelAvailable(context, record);
  }
  record.stateRevision++;
  const configOnlyMutation = CONFIG_ONLY_MUTATION_REASONS.has(reason);
  if (!configOnlyMutation) {
    record.updatedAt = Date.now();
  }
  const stateSnapshot = await snapshot(context, record, undefined, {
    modelAvailability: "current",
  });
  emitStateUpdated(context, record, reason, stateSnapshot.settings);
  return stateSnapshot;
}

export function afterPromptAccepted(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  record.stateRevision++;
  record.updatedAt = Date.now();
  emitStateUpdated(context, record, reason, { status: "running" });
  return {
    accepted: true as const,
    sessionId: record.app.sessionId,
    stateRevision: record.stateRevision,
  };
}

export function emitStateUpdated(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
  patch: unknown,
): void {
  const notification: ZCodeStateUpdatedNotification = {
    patch,
    reason,
    revision: record.stateRevision,
    scope: "session",
    sessionId: record.app.sessionId,
    type: "state.updated",
    workspace: record.workspace,
  };
  context.notify({ method: "state.updated", params: notification });
}
