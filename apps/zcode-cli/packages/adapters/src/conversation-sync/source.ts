import {
  TextCheckpointError,
  type SessionId,
  type SessionStorePort,
  type SyncScope,
} from "@zcode/contracts";
import type { ConversationSyncOutbox } from "./outbox.js";
import type { SyncCheckpointSource } from "./worker.js";
import { digest } from "./canonical.js";

/** Native host facts, not client-supplied workspace metadata. */
export interface NativeSyncSourceOwner {
  enumerate(): Promise<
    Array<{
      session: SessionId;
      workspacePurpose: "conversation" | "directory" | "unknown";
      hasLocalDirectory: boolean;
    }>
  >;
  /** Must fence exact owner/admission and settle work before running the callback. */
  withCheckpointBoundary<T>(
    session: SessionId,
    run: (facts: {
      workspacePurpose: "conversation" | "directory" | "unknown";
      hasLocalDirectory: boolean;
      location: string;
      generation: number;
      baseline: string | null;
    }) => Promise<T>,
  ): Promise<T>;
  blocked(session: SessionId, code: string): void;
}
/** Full startup/reconnect scans recover commits even when their notifications were lost. */
export function createNativeConversationSyncSource(options: {
  scope: SyncScope;
  owner: NativeSyncSourceOwner;
  store: SessionStorePort;
  outbox: ConversationSyncOutbox;
}): SyncCheckpointSource {
  return {
    async changes(after) {
      const exportCheckpoint = options.store.exportTextCheckpoint;
      if (!exportCheckpoint) throw new TextCheckpointError("unsupported_state");
      const items: Awaited<ReturnType<SyncCheckpointSource["changes"]>>["items"] = [];
      for (const item of await options.owner.enumerate()) {
        if (item.workspacePurpose !== "conversation" || item.hasLocalDirectory) continue;
        try {
          const captured = await options.owner.withCheckpointBoundary(
            item.session,
            async (facts) => {
              // 枚举后可能重新关联目录；必须在同一 owner 屏障内重新确认资格。
              if (facts.workspacePurpose !== "conversation" || facts.hasLocalDirectory) return null;
              return {
                checkpoint: await exportCheckpoint.call(options.store, { sessionID: item.session }),
                binding: facts,
              };
            },
          );
          if (!captured) continue;
          const latest = options.outbox.latest(options.scope, item.session);
          const previous = latest?.command.kind === "receive" ? latest.command.version : null;
          if (
            previous &&
            previous.location === captured.binding.location &&
            previous.generation === captured.binding.generation &&
            digest(previous.checkpoint) === digest(captured.checkpoint)
          )
            continue;
          const parent =
            previous?.location === captured.binding.location &&
            previous.generation === captured.binding.generation
              ? previous.id
              : captured.binding.baseline;
          const content = {
            parent,
            location: captured.binding.location,
            generation: captured.binding.generation,
            checkpoint: captured.checkpoint,
          };
          items.push({ ...item, version: { id: `snapshot:${digest(content)}`, ...content } });
        } catch (cause) {
          if (!(cause instanceof TextCheckpointError)) throw cause;
          options.owner.blocked(item.session, cause.code);
        }
      }
      // This is a durable scan generation, not a timestamp or a claim about unobserved source commits.
      return { cursor: after + 1, items };
    },
  };
}
