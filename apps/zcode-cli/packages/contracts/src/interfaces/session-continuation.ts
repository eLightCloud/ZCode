import type { ConversationRuntimeCommand, ConversationRuntimeResult } from "@zcode/shared";
import type { ProjectId } from "./shared.js";

export interface SessionContinuationStorePort {
  /** Native owner only. Target location is supplied by the trusted caller, never the package. */
  controlContinuation(
    input: ConversationRuntimeCommand,
    target: {
      directory: string;
      projectID: ProjectId;
    },
  ): Promise<ConversationRuntimeResult>;
}
