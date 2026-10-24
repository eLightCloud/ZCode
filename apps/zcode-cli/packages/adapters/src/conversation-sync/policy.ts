import type { Pool, PoolClient } from "pg";
import {
  conversationCenterConfigurationSchema,
  conversationCenterPolicySchema,
} from "@zcode/shared";
import { ConversationSyncError, type Logger } from "@zcode/contracts";
import type { ConversationCenterPolicy } from "@zcode/shared";

export async function readCenterPolicy(client: PoolClient) {
  const result = await client.query(
    "select revision,policy from zcode_sync.configuration where singleton=true",
  );
  if (result.rows.length !== 1) throw new ConversationSyncError("schema");
  const parsed = conversationCenterConfigurationSchema.safeParse({
    revision: Number(result.rows[0].revision),
    policy: result.rows[0].policy,
  });
  if (!parsed.success) throw new ConversationSyncError("schema");
  return parsed.data;
}
/** Separate minimal role: configuration authority grants no conversation content access. */
export function createConversationSyncPolicyStore(options: { pool: Pool; logger: Logger }) {
  async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await options.pool.connect();
    try {
      await client.query("begin");
      const role = await client.query(`select r.rolsuper,r.rolbypassrls,
        pg_has_role(current_user,'zcode_sync_configurator','MEMBER') as config,
        pg_has_role(current_user,'zcode_sync_runtime','MEMBER') as runtime,
        pg_has_role(current_user,c.relowner,'USAGE') as owns
        from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
        where r.rolname=current_user and n.nspname='zcode_sync' and c.relname='sessions'`);
      if (
        role.rows.length !== 1 ||
        role.rows[0].rolsuper ||
        role.rows[0].rolbypassrls ||
        !role.rows[0].config ||
        role.rows[0].runtime ||
        role.rows[0].owns
      )
        throw new ConversationSyncError("scope");
      const schema = await client.query("select version from zcode_sync.schema_version");
      if (schema.rows.length !== 1 || schema.rows[0].version !== 5)
        throw new ConversationSyncError("schema");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (cause) {
      await client.query("rollback");
      throw cause;
    } finally {
      client.release();
    }
  }
  return {
    read: () => transaction(readCenterPolicy),
    update: (revision: number, input: ConversationCenterPolicy) =>
      transaction(async (client) => {
        const policy = conversationCenterPolicySchema.parse(input);
        if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
          throw new ConversationSyncError("invalid");
        const result = await client.query(
          "update zcode_sync.configuration set policy=$1,revision=revision+1 where singleton=true and revision=$2 returning revision",
          [policy, revision],
        );
        if (result.rows.length !== 1) throw new ConversationSyncError("stale");
        options.logger.info("Conversation sync policy updated", {
          event: "conversation.sync.configuration",
          outcome: "updated",
          revision: revision + 1,
        });
        return readCenterPolicy(client);
      }),
  };
}
