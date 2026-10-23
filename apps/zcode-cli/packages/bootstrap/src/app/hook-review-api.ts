import type { WorkspaceHookReviewRequestPayload } from "@zcode/shared/zcode-protocol-v4";

import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-types.js";

import * as implementation0 from "./hook-review-request.js";
import * as implementation1 from "./hook-review-response.js";
import * as implementation2 from "./hook-review-revocation.js";
export interface WorkspaceHookReviewControllerApi {
  requestReview(
    ...args: Parameters<typeof implementation0.requestReview>
  ): Promise<WorkspaceHookReviewCommandResult>;
  respond(
    ...args: Parameters<typeof implementation1.respond>
  ): Promise<WorkspaceHookReviewCommandResult>;
  toggle(...args: Parameters<typeof implementation1.toggle>): Promise<
    WorkspaceHookReviewCommandResult & {
      request?: WorkspaceHookReviewRequestPayload;
    }
  >;
  revoke(
    ...args: Parameters<typeof implementation2.revoke>
  ): Promise<WorkspaceHookReviewCommandResult>;
  revokeCurrent(
    ...args: Parameters<typeof implementation2.revokeCurrent>
  ): Promise<WorkspaceHookReviewCommandResult>;
}
