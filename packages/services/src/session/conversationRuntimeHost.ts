import type { ConversationRuntimePort, ConversationRuntimeCommand } from "@zcode/shared";
import { conversationIndexProjectionSchema, conversationRuntimeResultSchema } from "@zcode/shared";
import type { TaskIndexRepo } from "./taskIndexRepo.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import { getConversationWorkspaceDir } from "../paths.js";

/** Native Host joins two existing owners. Neither index nor Core receives a second queue. */
export function createConversationRuntimeHost(options: {
  runtime: ConversationRuntimePort;
  index: TaskIndexRepo;
  agent: Pick<IZCodeAgentService, "captureTextCheckpoint">;
  captureBase?: (session: string) => Promise<{ baseVersion: string | null }>;
  beforeActivate?: (
    input: Extract<ConversationRuntimeCommand, { kind: "activate" | "cancel" | "activateOffline" }>,
  ) => Promise<void>;
}): ConversationRuntimePort {
  const tails = new Map<string, Promise<unknown>>();
  async function run(input: ConversationRuntimeCommand) {
    const target = {
      workspacePath: getConversationWorkspaceDir(),
      taskId: input.session,
      operation: input.operation,
    };
    if (input.kind === "cancel" && input.generation === undefined && input.version === undefined) {
      try {
        const current = await options.runtime.control({
          kind: "read",
          session: input.session,
          operation: input.operation,
        });
        if (current.operation !== input.operation) {
          await options.index.controlConversationIndexBarrier(
            ["active", "cancelled"].includes(current.state)
              ? { ...target, hold: false }
              : {
                  ...target,
                  operation: current.operation,
                  supersedeOperation: input.operation,
                  hold: true,
                },
          );
          return current;
        }
      } catch (error) {
        const code =
          error &&
          typeof error === "object" &&
          "data" in error &&
          error.data &&
          typeof error.data === "object" &&
          "code" in error.data
            ? error.data.code
            : error && typeof error === "object" && "code" in error
              ? error.code
              : undefined;
        if (code !== "not_found") throw error;
      }
    }
    if (input.kind === "close") {
      let current;
      try {
        current = await options.runtime.control({
          kind: "read",
          session: input.session,
          operation: input.operation,
        });
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            (("code" in error && error.code === "not_found") ||
              ("data" in error &&
                error.data &&
                typeof error.data === "object" &&
                "code" in error.data &&
                error.data.code === "not_found"))
          )
        )
          throw error;
      }
      if (current?.operation === input.operation && ["active", "cancelled"].includes(current.state))
        return current;
      await options.index.controlConversationIndexBarrier({
        ...target,
        hold: true,
        supersedeOperation: input.supersedeOperation,
      });
    }
    if (
      input.kind === "activate" ||
      input.kind === "activateOffline" ||
      (input.kind === "cancel" && input.generation && input.version)
    ) {
      const current = await options.runtime.control({
        kind: "read",
        session: input.session,
        operation: input.operation,
      });
      if (
        current.operation === input.operation &&
        current.state === "active" &&
        current.generation === input.generation &&
        current.version === input.version
      ) {
        await options.index.controlConversationIndexBarrier({ ...target, hold: false });
        return options.runtime.control(input);
      }
      await options.index.controlConversationIndexBarrier({ ...target, hold: true });
      await options.beforeActivate?.(input);
    }
    const value = await options.runtime.control(input);
    if (input.kind === "capture") {
      const management = await options.index.withConversationSyncFacts(
        { ...target, continuationOperation: input.operation },
        async (facts) => facts,
      );
      const base = await options.captureBase?.(input.session);
      return conversationRuntimeResultSchema.parse({ ...value, management, ...base });
    }
    if (input.kind === "apply") {
      const current = await options.runtime.control({
        kind: "read",
        session: input.session,
        operation: input.operation,
      });
      // 激活 ACK 丢失后，重查不能再覆盖用户随后在当前代次产生的索引变化。
      if (current.operation === input.operation && current.state === "active") return current;
      if (!value.management) throw new Error("continuation_management_unknown");
      const captured = await options.agent.captureTextCheckpoint({
        workspacePath: target.workspacePath,
        sessionId: input.session,
        includeIndexProjection: true,
      });
      const projection = conversationIndexProjectionSchema.parse(captured.indexProjection);
      if (projection.meta.taskId !== input.session)
        throw new Error("continuation_identity_mismatch");
      await options.index.applyContinuationIndex({
        operation: input.operation,
        management: value.management,
        searchableText: projection.searchableText,
        meta: {
          ...projection.meta,
          workspacePath: target.workspacePath,
          workspacePurpose: "conversation",
          provider: "glm",
        },
      });
    }
    if (
      input.kind === "cancel" &&
      value.operation !== input.operation &&
      !["active", "cancelled"].includes(value.state)
    )
      await options.index.controlConversationIndexBarrier({
        ...target,
        operation: value.operation,
        supersedeOperation: input.operation,
        hold: true,
      });
    else if (
      input.kind === "activate" ||
      input.kind === "activateOffline" ||
      input.kind === "cancel"
    )
      await options.index.controlConversationIndexBarrier({ ...target, hold: false });
    return value;
  }
  return {
    content: options.runtime.content ? (input) => options.runtime.content!(input) : undefined,
    control(input) {
      // Activation's owner verification reads the same persistent guard. Read-only Core
      // queries must not queue behind the Host mutation whose verification requested them.
      if (input.kind === "read") return options.runtime.control(input);
      const previous = tails.get(input.session) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(() => run(input));
      tails.set(input.session, pending);
      void pending
        .finally(() => {
          if (tails.get(input.session) === pending) tails.delete(input.session);
        })
        .catch(() => {});
      return pending;
    },
  };
}
