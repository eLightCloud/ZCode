import type { WorkspaceHookReviewFlowRegistry } from "@zcode/core";
import type { WorkspaceHookReviewFlow } from "@zcode/core";
import type { WorkspaceHookRuntimeAdmissionPort } from "@zcode/core";
import type { WorkspaceHookTrustCoordinator } from "@zcode/core";
import type { WorkspaceHookReviewTelemetry } from "./workspace-hook-review-telemetry.js";
import type { WorkspaceHookReviewHostPort } from "./workspace-hook-review-types.js";
import type { WorkspaceHookReviewMutationPort } from "./workspace-hook-review-types.js";
import type { WorkspaceHookTrustStoreMutationPort } from "./workspace-hook-review-types.js";
import type { WorkspaceHookReviewRequestPayload } from "@zcode/shared/zcode-protocol-v4";
import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-types.js";
import type { WorkspaceHookBundleSnapshot } from "@zcode/contracts";
import type { WorkspaceHookSnapshotEvaluation } from "@zcode/core";
import type { WorkspaceHookReviewTarget } from "@zcode/core";
import type { WorkspaceHookReviewDecision } from "@zcode/shared/zcode-protocol-v4";
import type { WorkspaceHookTrustRevokeTarget } from "@zcode/shared/zcode-protocol-v4";

/** 同一 owner 的唯一内部状态 / 协作形状；不从实现类反向取型。 */
export interface WorkspaceHookReviewControllerMethodsContext {
  readonly admission: WorkspaceHookRuntimeAdmissionPort;
  readonly appVersion: string | undefined;
  applyPersistentTrust(reviewItemIds: readonly string[]): Promise<{ grantedRecordCount?: number }>;
  buildRequest(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
    flow: { reviewFlowId: string; generation: number },
  ): WorkspaceHookReviewRequestPayload;
  readonly coordinator: WorkspaceHookTrustCoordinator;
  readonly createId: () => string;
  emitAdmissionUpdatedAfterMutation(): Promise<void>;
  enqueueMutation<T>(operation: () => Promise<T>): Promise<T>;
  generation: number;
  readonly host: WorkspaceHookReviewHostPort;
  readonly mutation: WorkspaceHookReviewMutationPort;
  mutationQueue: Promise<unknown>;
  readonly now: () => number;
  openOrReuseFlow(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
  ): Promise<WorkspaceHookReviewFlow>;
  openReviewFlowForNewPendingItems(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined>;
  refreshPendingFlow(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined>;
  readonly registry: WorkspaceHookReviewFlowRegistry;
  requestReview(target: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;
  respond(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
  ): Promise<WorkspaceHookReviewCommandResult>;
  reviewFlowId: string | undefined;
  revoke(
    target: WorkspaceHookReviewTarget,
    reviewItemIds: readonly string[],
  ): Promise<WorkspaceHookReviewCommandResult>;
  revokeCurrent(target: WorkspaceHookTrustRevokeTarget): Promise<WorkspaceHookReviewCommandResult>;
  readonly sessionId: string;
  readonly store: Promise<WorkspaceHookTrustStoreMutationPort>;
  superviseFlow(flow: WorkspaceHookReviewFlow): Promise<void>;
  readonly supervisedFlows: WeakMap<WorkspaceHookReviewFlow, Promise<void>>;
  readonly telemetry: WorkspaceHookReviewTelemetry;
  toggle(
    target: WorkspaceHookReviewTarget,
    reviewItemId: string,
    enabled: boolean,
  ): Promise<
    WorkspaceHookReviewCommandResult & {
      request?: WorkspaceHookReviewRequestPayload;
    }
  >;
}
