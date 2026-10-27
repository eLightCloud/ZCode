import { conversationIndexFactsSchema, type ConversationSyncHost } from "@zcode/shared";
import {
  TextCheckpointError,
  ConversationSyncError,
  textCheckpointSchema,
  checkpointOriginalCommandId,
  type Logger,
  type SyncScope,
} from "@zcode/contracts";
import type { ConversationSyncOutbox } from "./outbox.js";
import type { SyncCheckpointSource } from "./worker.js";
import { digest } from "./canonical.js";
import { readRegisteredFiles } from "./registered-files.js";
import type { ConversationSyncStore } from "@zcode/contracts";

/** Real Host captures both owners under their barriers; this adapter owns durable versioning. */
export function createHostConversationSyncSource(options: {
  scope: SyncScope;
  location: string;
  trustedInstance: boolean;
  host: ConversationSyncHost;
  outbox: ConversationSyncOutbox;
  center?: ConversationSyncStore;
  logger?: Logger;
  blocked(session: string, code: string): void;
}): SyncCheckpointSource {
  function belongsElsewhere(session: string, command?: string): boolean {
    try {
      options.outbox.checkLegacyOwner(options.scope, session, command);
      return false;
    } catch (cause) {
      if (!(cause instanceof ConversationSyncError) || cause.code !== "scope") throw cause;
      // 已绑定另一账号的会话不是未知存量；切换登录不能读其正文或改绑归属。
      options.logger?.debug("Conversation excluded from current account scan", {
        event: "conversation.sync.capture",
        sessionId: session,
        outcome: "excluded",
        reasonCode: "other_account",
      });
      return true;
    }
  }
  return {
    async prepare(request) {
      if (request.command.kind !== "receive" || !request.command.version.checkpoint) return;
      const expected = request.command.version.files ?? [];
      if (!expected.length) return;
      if (!options.center?.files) throw new ConversationSyncError("blocked");
      const values = await readRegisteredFiles(
        request.session,
        request.command.version.checkpoint,
        options.host.readArtifact
          ? (uri) => options.host.readArtifact!(request.session, uri)
          : undefined,
      );
      if (digest(values.map((value) => value.file)) !== digest(expected))
        throw new ConversationSyncError("storage");
      for (const { file, bytes } of values)
        await options.center.files.put(options.scope, file, bytes);
    },
    async changes(after) {
      const items: Awaited<ReturnType<SyncCheckpointSource["changes"]>>["items"] = [];
      for (const session of await options.host.enumerate()) {
        try {
          if (belongsElsewhere(session)) continue;
          const captured = await options.host.capture(session);
          const management = conversationIndexFactsSchema.parse(captured.management);
          const checkpoint = management.deleted
            ? null
            : textCheckpointSchema.parse(
                JSON.parse(Buffer.from(captured.dataBase64, "base64").toString("utf8")),
              );
          if (
            checkpoint &&
            (checkpoint.session.parentID ?? null) !== (management.parentSessionId ?? null)
          )
            throw new ConversationSyncError("invalid");
          if (checkpoint && checkpoint.session.id !== session)
            throw new Error("checkpoint_identity");
          const first = checkpoint ? checkpointOriginalCommandId(checkpoint) : undefined;
          if (belongsElsewhere(session, first)) continue;
          if (
            !options.trustedInstance &&
            !options.outbox.ownsSession(options.scope, session, first, checkpoint?.session.parentID)
          ) {
            options.blocked(session, "original_owner_unknown");
            continue;
          }
          const previous = options.outbox.baseline(options.scope, session);
          const files = checkpoint
            ? (
                await readRegisteredFiles(
                  session,
                  checkpoint,
                  options.host.readArtifact
                    ? (uri) => options.host.readArtifact!(session, uri)
                    : undefined,
                )
              ).map((value) => value.file)
            : [];
          if (
            previous &&
            digest({
              checkpoint: previous.checkpoint,
              management: previous.management,
              files: previous.files ?? [],
            }) === digest({ checkpoint, management, files })
          )
            continue;
          // 捕获只保存当前 outbox 分支代次；在线登记 / 激活另经原生意图，保存本身不授予执行。
          // 整卷迁移保留了准确 outbox 前序；更换位置不能丢掉已知因果链。
          const content = {
            parent: previous?.id ?? null,
            location: options.location,
            generation: options.outbox.branchGeneration(options.scope, session),
            checkpoint,
            management,
            ...(files.length ? { files } : {}),
          };
          items.push({
            session: session as import("@zcode/contracts").SessionId,
            workspacePurpose: "conversation",
            hasLocalDirectory: false,
            version: { id: `snapshot:${digest(content)}`, ...content },
          });
        } catch (cause) {
          // 捕获边界逐会话隔离；只公开稳定原因码，不把 SQL / 文件路径 / payload 打进日志。
          const nativeCode =
            cause instanceof TextCheckpointError || cause instanceof ConversationSyncError
              ? cause.code
              : cause instanceof Error && /^conversation_[a-z_]+$/.test(cause.message)
                ? cause.message
                : "capture_failure";
          options.blocked(session, nativeCode);
        }
      }
      return { cursor: after + 1, items };
    },
  };
}
