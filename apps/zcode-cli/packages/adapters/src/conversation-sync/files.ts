import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  ConversationSyncError,
  syncScopeSchema,
  type ConversationFileStore,
  type ConversationObjectBytesPort,
  type ConversationObjectReceipt,
  type SyncScope,
  type Logger,
} from "@zcode/contracts";
import { conversationFileSchema, type ConversationFile } from "@zcode/shared";
import { SyncDiagnosticError } from "./monitoring.js";
import { canonical } from "./canonical.js";

type Limits = { maxSubjectBytes: number };
type Transaction = <T>(
  scope: SyncScope,
  work: (client: PoolClient, limits: Limits) => Promise<T>,
) => Promise<T>;
function verify(file: ConversationFile, bytes: Uint8Array) {
  if (
    bytes.length !== file.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  )
    throw new SyncDiagnosticError("storage", "integrity");
}
export function createConversationFileStore(
  transaction: Transaction,
  objects: ConversationObjectBytesPort,
  logger?: Logger,
): ConversationFileStore {
  async function known(scope: SyncScope, file: ConversationFile) {
    return transaction(scope, async (client, limits) => {
      const result = await client.query(
        "select bytes,receipt from zcode_sync.file_objects where sha256=$1",
        [file.sha256],
      );
      if (!result.rowCount) {
        if (file.bytes > limits.maxSubjectBytes) throw new SyncDiagnosticError("limit", "subject_capacity");
        return null;
      }
      if (Number(result.rows[0].bytes) !== file.bytes) throw new SyncDiagnosticError("storage", "integrity");
      return result.rows[0].receipt as ConversationObjectReceipt;
    });
  }
  return {
    async put(rawScope, raw, bytes) {
      const scope = syncScopeSchema.parse(rawScope);
      const file = conversationFileSchema.parse(raw);
      verify(file, bytes);
      try {
        const existing = await known(scope, file);
        if (existing) verify(file, await objects.read(scope, file, existing));
        else
          await transaction(scope, async (client, limits) => {
            // 与正文共用主体锁；检查后直到有界上传和回执提交结束都不能让并发写占走配额。
            await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
              canonical(scope),
            ]);
            const previous = await client.query(
              "select bytes,receipt from zcode_sync.file_objects where sha256=$1",
              [file.sha256],
            );
            if (previous.rowCount) {
              if (Number(previous.rows[0].bytes) !== file.bytes)
                throw new SyncDiagnosticError("storage", "integrity");
              verify(file, await objects.read(scope, file, previous.rows[0].receipt));
              return;
            }
            const used =
              await client.query(`select ((select coalesce(sum(bytes),0) from zcode_sync.payloads)+
          (select coalesce(sum(bytes),0) from zcode_sync.file_objects))::text as bytes`);
            if (Number(used.rows[0].bytes) + file.bytes > limits.maxSubjectBytes)
              throw new SyncDiagnosticError("limit", "subject_capacity");
            // 未确认上传由资源 owner 按派生内容键核对准确版本；事务失败后重试不重复造版本。
            const receipt = await objects.put(scope, file, bytes);
            verify(file, await objects.read(scope, file, receipt));
            await client.query("insert into zcode_sync.file_objects values($1,$2,$3,$4,$5)", [
              scope.tenant,
              scope.subject,
              file.sha256,
              file.bytes,
              receipt,
            ]);
          });
        logger?.info("Conversation file saved", {
          event: "conversation.sync.file",
          artifactRef: file.uri,
          outcome: "saved",
        });
      } catch (cause) {
        logger?.warn("Conversation file unconfirmed", {
          event: "conversation.sync.file",
          artifactRef: file.uri,
          outcome: "unconfirmed",
          code: cause instanceof ConversationSyncError ? cause.code : "storage",
        });
        throw cause;
      }
    },
    async read(rawScope, raw) {
      const scope = syncScopeSchema.parse(rawScope);
      const file = conversationFileSchema.parse(raw),
        receipt = await known(scope, file);
      if (!receipt) throw new ConversationSyncError("not_found");
      const bytes = await objects.read(scope, file, receipt);
      verify(file, bytes);
      return bytes;
    },
  };
}
