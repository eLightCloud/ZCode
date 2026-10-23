import { SessionEventType } from "@zcode/contracts";

import { createWorkspaceHookTrustRecords } from "@zcode/core";

import type { WorkspaceHookReviewControllerMethodsContext } from "./hook-review-context.js";
export async function applyPersistentTrust(
  this: WorkspaceHookReviewControllerMethodsContext,
  reviewItemIds: readonly string[],
): Promise<{ grantedRecordCount?: number }> {
  const snapshot = this.admission.getCurrentSnapshot();
  this.coordinator.assertPersistentTrustMutationAllowed(snapshot.workspaceIdentity);
  const records = createWorkspaceHookTrustRecords({
    snapshot,
    reviewItemIds,
    grantedAt: new Date(this.now()).toISOString(),
    ...(this.appVersion ? { appVersion: this.appVersion } : {}),
  });
  const file = await (await this.store).grant(records);
  this.coordinator.replacePersistentTrustRecords(file.records, {
    status: "ok",
  });
  return { grantedRecordCount: records.length };
}

/**
 * 软门禁:mutation 完成后重新评估 pending 状态并发射 AdmissionUpdated。
 *
 * 口径与 admission 一致:configuredEnabled && admissionClass === "pending"。
 * pendingCount === 0 也要发,投影据此清空提示条。
 * 通过 admission 的 invalidate → 触发 evaluateDispatch 内的 refreshEvaluation;
 * 这里直接用 coordinator 重新评估快照,与 admission.emitAdmissionState 同源。
 */

export async function emitAdmissionUpdatedAfterMutation(
  this: WorkspaceHookReviewControllerMethodsContext,
): Promise<void> {
  const snapshot = this.admission.getCurrentSnapshot();
  const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
  const pendingCount = evaluation.items.filter(
    (item) => item.configuredEnabled && item.admissionClass === "pending",
  ).length;
  await this.host.emit({
    type: SessionEventType.WorkspaceHookAdmissionUpdated,
    payload: {
      pendingCount,
      bundleDigest: snapshot.bundleDigest,
      ...(snapshot.workspaceIdentity ? { workspaceIdentity: snapshot.workspaceIdentity } : {}),
    },
  });
}
