import type { WorkspaceHookReviewController } from "./workspace-hook-review-controller.js";

/** 同一 owner 的内部类型视图；不复制状态，不暴露到端口。 */
export interface WorkspaceHookReviewControllerMethodsContext {
  readonly admission: WorkspaceHookReviewController["admission"];
  readonly appVersion: WorkspaceHookReviewController["appVersion"];
  readonly coordinator: WorkspaceHookReviewController["coordinator"];
  readonly host: WorkspaceHookReviewController["host"];
  readonly telemetry: WorkspaceHookReviewController["telemetry"];
  readonly mutation: WorkspaceHookReviewController["mutation"];
  readonly sessionId: WorkspaceHookReviewController["sessionId"];
  readonly store: WorkspaceHookReviewController["store"];
  readonly now: WorkspaceHookReviewController["now"];
  readonly createId: WorkspaceHookReviewController["createId"];
  readonly registry: WorkspaceHookReviewController["registry"];
  readonly supervisedFlows: WorkspaceHookReviewController["supervisedFlows"];
  reviewFlowId: WorkspaceHookReviewController["reviewFlowId"];
  generation: WorkspaceHookReviewController["generation"];
  mutationQueue: WorkspaceHookReviewController["mutationQueue"];
  superviseFlow: WorkspaceHookReviewController["superviseFlow"];
  requestReview: WorkspaceHookReviewController["requestReview"];
  respond: WorkspaceHookReviewController["respond"];
  toggle: WorkspaceHookReviewController["toggle"];
  revoke: WorkspaceHookReviewController["revoke"];
  revokeCurrent: WorkspaceHookReviewController["revokeCurrent"];
  refreshPendingFlow: WorkspaceHookReviewController["refreshPendingFlow"];
  openReviewFlowForNewPendingItems: WorkspaceHookReviewController["openReviewFlowForNewPendingItems"];
  openOrReuseFlow: WorkspaceHookReviewController["openOrReuseFlow"];
  buildRequest: WorkspaceHookReviewController["buildRequest"];
  applyPersistentTrust: WorkspaceHookReviewController["applyPersistentTrust"];
  enqueueMutation: WorkspaceHookReviewController["enqueueMutation"];
  emitAdmissionUpdatedAfterMutation: WorkspaceHookReviewController["emitAdmissionUpdatedAfterMutation"];
}
