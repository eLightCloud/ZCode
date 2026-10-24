import { conversationIndexFactsSchema, type ConversationSyncHost } from "@zcode/shared";
import { textCheckpointSchema, type SyncScope } from "@zcode/contracts";
import type { ConversationSyncOutbox } from "./outbox.js";
import type { SyncCheckpointSource } from "./worker.js";
import { digest } from "./canonical.js";

/** Real Host captures both owners under their barriers; this adapter owns durable versioning. */
export function createHostConversationSyncSource(options: {
  scope: SyncScope;
  location: string;
  trustedInstance: boolean;
  host: ConversationSyncHost;
  outbox: ConversationSyncOutbox;
  blocked(session: string, code: string): void;
}): SyncCheckpointSource {
  return {
    async changes(after) {
      const items: Awaited<ReturnType<SyncCheckpointSource["changes"]>>["items"] = [];
      for (const session of await options.host.enumerate()) {
        try {
          const captured = await options.host.capture(session);
          const management = conversationIndexFactsSchema.parse(captured.management);
          const checkpoint = management.deleted
            ? null
            : textCheckpointSchema.parse(
                JSON.parse(Buffer.from(captured.dataBase64, "base64").toString("utf8")),
              );
          if (checkpoint && checkpoint.session.id !== session)
            throw new Error("checkpoint_identity");
          const first =
            checkpoint?.messages[0]?.info.anchor?.sourceCommandId ??
            checkpoint?.inputs.find(
              (input) => input.promotedMessageID === checkpoint.messages[0]?.info.id,
            )?.payload.conversationInputIntent?.sourceCommandId;
          if (
            !options.trustedInstance &&
            !options.outbox.ownsSession(options.scope, session, first)
          ) {
            options.blocked(session, "original_owner_unknown");
            continue;
          }
          const latest = options.outbox.latest(options.scope, session);
          const previous = latest?.command.kind === "receive" ? latest.command.version : null;
          if (
            previous &&
            digest({ checkpoint: previous.checkpoint, management: previous.management }) ===
              digest({ checkpoint, management })
          )
            continue;
          // Until native online admission is wired this is a local branch, never an execution grant.
          // 整卷迁移保留了准确 outbox 前序；更换位置不能丢掉已知因果链。
          const content = {
            parent: previous?.id ?? null,
            location: options.location,
            generation: 0,
            checkpoint,
            management,
          };
          items.push({
            session: session as import("@zcode/contracts").SessionId,
            workspacePurpose: "conversation",
            hasLocalDirectory: false,
            version: { id: `snapshot:${digest(content)}`, ...content },
          });
        } catch {
          // A single busy/unsupported session must not starve other qualified sessions.
          options.blocked(session, "native_capture_unavailable");
        }
      }
      return { cursor: after + 1, items };
    },
  };
}
