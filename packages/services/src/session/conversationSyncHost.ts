import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  conversationIndexFactsSchema,
  conversationIndexProjectionSchema,
  type ConversationSyncHost,
} from "@zcode/shared";
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
    async rebuildIndex(input) {
      const facts = conversationIndexFactsSchema.parse(input.management);
      if (facts.pinned === undefined) throw new Error("conversation_sync_rebuild_unsupported");
      const params = { workspacePath: getConversationWorkspaceDir(), sessionId: input.session };
      if (await options.index.getTaskMeta(target(input.session)))
        throw new Error("conversation_sync_index_exists");
      if (!input.isCurrent()) throw new Error("conversation_sync_identity_changed");
      const captured = await options.agent.captureTextCheckpoint({
        ...params,
        includeIndexProjection: true,
      });
      // PG JSONB may reorder object keys; compare JSON values, never serialization order.
      if (
        !isDeepStrictEqual(
          JSON.parse(Buffer.from(captured.dataBase64, "base64").toString("utf8")),
          JSON.parse(Buffer.from(input.dataBase64, "base64").toString("utf8")),
        )
      )
        throw new Error("conversation_sync_checkpoint_changed");
      const projection = conversationIndexProjectionSchema.parse(captured.indexProjection);
      if (projection.meta.taskId !== input.session)
        throw new Error("conversation_sync_rebuild_identity");
      await options.index.rebuildConversationIndex({
        meta: {
          ...projection.meta,
          workspacePath: getConversationWorkspaceDir(),
          workspacePurpose: "conversation",
          provider: "glm",
        },
        management: facts,
        searchableText: projection.searchableText,
        isCurrent: input.isCurrent,
      });
    },
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
