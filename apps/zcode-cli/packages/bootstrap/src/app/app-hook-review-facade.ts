import type { ZCodeApp } from "./types.js";

import { WorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";

export function createAppHookReviewFacade(
  workspaceHookRuntimeSecurity: WorkspaceHookRuntimeSecurity | undefined,
): Pick<
  ZCodeApp,
  | "respondWorkspaceHookReview"
  | "toggleWorkspaceHookReviewItem"
  | "revokeWorkspaceHookTrust"
  | "requestWorkspaceHookReview"
  | "reloadWorkspaceHookTrust"
> {
  return {
    respondWorkspaceHookReview: (input) =>
      workspaceHookRuntimeSecurity?.respond(
        {
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
          reviewFlowId: input.reviewFlowId,
          generation: input.generation,
          interactionId: input.interactionId,
        },
        input.decision,
      ) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    toggleWorkspaceHookReviewItem: (input) =>
      workspaceHookRuntimeSecurity?.toggle(
        {
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
          reviewFlowId: input.reviewFlowId,
          generation: input.generation,
          interactionId: input.interactionId,
        },
        input.reviewItemId,
        input.enabled,
      ) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    revokeWorkspaceHookTrust: (input) =>
      ("hookDeclarationDigests" in input
        ? workspaceHookRuntimeSecurity?.revokeCurrent(input)
        : workspaceHookRuntimeSecurity?.revoke(
            {
              sessionId: input.sessionId,
              taskId: input.taskId,
              runId: input.runId,
              ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
              workspaceIdentity: input.workspaceIdentity,
              bundleDigest: input.bundleDigest,
              reviewFlowId: input.reviewFlowId,
              generation: input.generation,
              interactionId: input.interactionId,
            },
            input.reviewItemIds,
          )) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    requestWorkspaceHookReview: (input) =>
      workspaceHookRuntimeSecurity?.requestReview({
        workspaceIdentity: input.workspaceIdentity,
        bundleDigest: input.bundleDigest,
      }) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    // Settings pretrust 写盘后由 server 按 workspace 调用：重载 Trust store 到本
    // session 的 coordinator 并重发 admission 状态（详见 types.ts 注释）。
    reloadWorkspaceHookTrust: () =>
      workspaceHookRuntimeSecurity?.reloadTrust() ?? Promise.resolve(),
  } satisfies Partial<ZCodeApp>;
}
