import { type WorkspaceHookReviewTarget } from "@zcode/core";

import type { WorkspaceHookTrustRevokeTarget } from "@zcode/shared/zcode-protocol-v4";

import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-types.js";

import { resolveWorkspaceHookReviewDigests } from "./workspace-hook-review-request.js";

import type { WorkspaceHookReviewControllerMethodsContext } from "./hook-review-context.js";
import { applyWorkspaceHookRevoke } from "./workspace-hook-review-revoke.js";
export function revoke(
  this: WorkspaceHookReviewControllerMethodsContext,
  target: WorkspaceHookReviewTarget,
  reviewItemIds: readonly string[],
): Promise<WorkspaceHookReviewCommandResult> {
  return this.enqueueMutation(async () => {
    const validation = this.registry.validate(target, {
      action: "trust_selected",
      reviewItemIds: [...reviewItemIds],
    });
    if (!validation.accepted) return validation;
    const snapshot = this.admission.getCurrentSnapshot();
    const result = await applyWorkspaceHookRevoke({
      coordinator: this.coordinator,
      digests: resolveWorkspaceHookReviewDigests(snapshot, validation.reviewItemIds),
      reviewItemIds: validation.reviewItemIds,
      snapshot,
      store: this.store,
    });
    if (result.accepted) {
      this.telemetry.revoked(snapshot.bundleDigest, validation.reviewItemIds.length);
      await this.refreshPendingFlow(snapshot);
      // 软门禁:revoke 后重新评估 pending 状态
      await this.emitAdmissionUpdatedAfterMutation();
    }
    return result;
  });
}

export function revokeCurrent(
  this: WorkspaceHookReviewControllerMethodsContext,
  target: WorkspaceHookTrustRevokeTarget,
): Promise<WorkspaceHookReviewCommandResult> {
  return this.enqueueMutation(async () => {
    const snapshot = this.admission.getCurrentSnapshot();
    if (
      target.sessionId !== this.sessionId ||
      target.remoteSessionId !== this.host.remoteSessionId ||
      target.workspaceIdentity !== snapshot.workspaceIdentity ||
      target.bundleDigest !== snapshot.bundleDigest
    ) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch" as const,
      };
    }
    const digests = [...new Set(target.hookDeclarationDigests)];
    const entries = snapshot.hooks.filter((entry) => digests.includes(entry.hookDeclarationDigest));
    if (
      digests.length === 0 ||
      new Set(entries.map((entry) => entry.hookDeclarationDigest)).size !== digests.length
    ) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch" as const,
      };
    }
    const result = await applyWorkspaceHookRevoke({
      coordinator: this.coordinator,
      digests,
      reviewItemIds: entries.map((entry) => entry.reviewItemId),
      snapshot,
      store: this.store,
    });
    if (result.accepted) {
      this.telemetry.revoked(snapshot.bundleDigest, digests.length);
      await this.refreshPendingFlow(snapshot);
      // 软门禁:revokeCurrent 后重新评估 pending 状态
      await this.emitAdmissionUpdatedAfterMutation();
    }
    return result;
  });
}
