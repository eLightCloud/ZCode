import type { ConversationRuntimePort, ConversationRuntimeCommand } from "@zcode/shared";
import type { IZCodeAgentService, IModelSelectionService } from "../../index.js";
import type { TaskIndexRepo } from "../taskIndexRepo.js";

export type ConversationModelSelectionReader = Pick<IModelSelectionService, "getView">;

/** Joins existing native writers; owns no execution or persistent conversation state. */
export interface ConversationRuntimeHostOptions {
  runtime: ConversationRuntimePort;
  index: TaskIndexRepo;
  agent: Pick<IZCodeAgentService, "captureTextCheckpoint">;
  prepareWorkspace?: () => Promise<unknown>;
  captureBase?: (session: string) => Promise<{ baseVersion: string | null }>;
  models?: ConversationRuntimePort["models"];
  beforeActivate?: (
    input: Extract<ConversationRuntimeCommand, { kind: "activate" | "cancel" | "activateOffline" }>,
  ) => Promise<void>;
}
