import type { Pool } from "pg";
import { ConversationSyncError } from "@zcode/contracts";

const tables = {
  sessions: `session text not null, state jsonb not null, primary key (tenant, subject, session)`,
  payloads: `digest text not null, payload jsonb not null, bytes bigint not null check(bytes > 0),
    primary key (tenant, subject, digest)`,
  versions: `session text not null, id text not null, parent text, location text not null,
    generation bigint not null check(generation >= 0), digest text,
    primary key (tenant, subject, session, id),
    foreign key (tenant, subject, session) references zcode_sync.sessions,
    foreign key (tenant, subject, digest) references zcode_sync.payloads`,
  receipts: `session text not null, operation uuid not null, fingerprint text not null,
    receipt jsonb not null, primary key (tenant, subject, session, operation),
    foreign key (tenant, subject, session) references zcode_sync.sessions`,
};
const scopeCheck = `tenant::text = current_setting('zcode_sync.tenant', true)
  and subject::text = current_setting('zcode_sync.subject', true)`;
/** Explicit native migration entry; never called by enterprise Alembic or a runtime request. */
export async function migrateConversationSync(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(861420024)");
    await client.query("create schema if not exists zcode_sync");
    await client.query(`create table if not exists zcode_sync.schema_version
      (singleton boolean primary key default true check(singleton), version integer not null)`);
    const previous = await client.query("select version from zcode_sync.schema_version");
    if (previous.rows.length && previous.rows[0].version !== 1)
      throw new ConversationSyncError("schema");
    if (!previous.rows.length) {
      await client.query(`do $$ begin
        if not exists(select 1 from pg_roles where rolname = 'zcode_sync_runtime') then
          create role zcode_sync_runtime nologin nosuperuser nobypassrls;
        end if;
      end $$`);
      for (const [table, columns] of Object.entries(tables)) {
        await client.query(
          `create table zcode_sync.${table} (tenant uuid not null, subject uuid not null, ${columns})`,
        );
        await client.query(`alter table zcode_sync.${table} enable row level security`);
        await client.query(`alter table zcode_sync.${table} force row level security`);
        await client.query(
          `create policy subject_scope on zcode_sync.${table} using (${scopeCheck}) with check (${scopeCheck})`,
        );
      }
      await client.query("insert into zcode_sync.schema_version(version) values(1)");
    }
    const role = await client.query(
      "select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname='zcode_sync_runtime'",
    );
    if (
      role.rows.length !== 1 ||
      role.rows[0].rolsuper ||
      role.rows[0].rolbypassrls ||
      role.rows[0].rolcanlogin
    )
      throw new ConversationSyncError("scope");
    await client.query("grant usage on schema zcode_sync to zcode_sync_runtime");
    await client.query("grant select on all tables in schema zcode_sync to zcode_sync_runtime");
    await client.query(
      "grant insert on zcode_sync.sessions, zcode_sync.payloads, zcode_sync.versions, zcode_sync.receipts to zcode_sync_runtime",
    );
    await client.query("grant update(state) on zcode_sync.sessions to zcode_sync_runtime");
    await client.query("commit");
  } catch (cause) {
    await client.query("rollback");
    throw cause;
  } finally {
    client.release();
  }
}
