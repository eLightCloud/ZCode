import type { PoolClient } from "pg";
import { ConversationSyncError, syncScopeSchema, type SyncScope } from "@zcode/contracts";
import { CONVERSATION_SYNC_SCHEMA_VERSION } from "./migration.js";

/** One native role boundary for business writes and low-sensitivity observations. */
export async function requireRuntimeScope(client: PoolClient, scope?: SyncScope) {
  if (scope) {
    const checked = syncScopeSchema.parse(scope);
    await client.query("select set_config('zcode_sync.tenant',$1,true),set_config('zcode_sync.subject',$2,true)", [checked.tenant, checked.subject]);
  }
  const role = (await client.query(`select r.rolsuper,r.rolbypassrls,
    pg_has_role(current_user,'zcode_sync_runtime','MEMBER') as runtime,
    pg_has_role(current_user,'zcode_sync_configurator','MEMBER') as config,
    pg_has_role(current_user,to_regrole('zcode_sync_observer'),'MEMBER') as observer,
    pg_has_role(current_user,c.relowner,'USAGE') as owns
    from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
    where r.rolname=current_user and n.nspname='zcode_sync' and c.relname='sessions'`)).rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || !role.runtime || role.config || role.observer || role.owns)
    throw new ConversationSyncError("scope");
  const schema = await client.query("select version from zcode_sync.schema_version");
  if (schema.rows.length !== 1 || schema.rows[0].version !== CONVERSATION_SYNC_SCHEMA_VERSION) throw new ConversationSyncError("schema");
}
