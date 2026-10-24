import { resolve } from "node:path";
import type { ConversationSyncHost } from "@zcode/shared";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { TaskIndexRepo } from "./taskIndexRepo.js";
import { getConversationWorkspaceDir } from "../paths.js";

/** Host-only producer; no renderer-supplied workspace or qualification flags. */
export function createConversationSyncHost(options: {
  index: TaskIndexRepo;
  agent: Pick<IZCodeAgentService, "captureTextCheckpoint">;
}): ConversationSyncHost {
  function target(taskId: string) {
    return { workspacePath: getConversationWorkspaceDir(), taskId };
  }
  return {
    async enumerate() {
      const rows = await options.index.listTaskMetas({
        workspacePath: getConversationWorkspaceDir(),
        provider: "glm",
        includeDeleted: true,
      });
      return rows
        .filter(
          (row) =>
            !row.workspaceIdentity &&
            resolve(row.workspacePath) === resolve(getConversationWorkspaceDir()),
        )
        .map((row) => row.taskId);
    },
    async capture(session) {
      return options.index.withConversationSyncFacts(target(session), async (management) => ({
        ...(management.deleted
          ? { dataBase64: "" }
          : await options.agent.captureTextCheckpoint({
              workspacePath: getConversationWorkspaceDir(),
              sessionId: session,
            })),
        management,
      }));
    },
  };
}
