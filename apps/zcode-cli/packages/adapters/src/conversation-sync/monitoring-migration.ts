import type { PoolClient } from "pg";
import { ConversationSyncError } from "@zcode/contracts";

/** Native-owned metadata only; this role cannot log in or read checkpoint bodies. */
export async function migrateMonitoring(client: PoolClient) {
  await client.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='zcode_sync_observer') then
      create role zcode_sync_observer nologin nosuperuser nobypassrls;
    end if; end $$`);
  const role = await client.query("select rolsuper,rolbypassrls,rolcanlogin from pg_roles where rolname='zcode_sync_observer'");
  if (role.rows.length !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls || role.rows[0].rolcanlogin)
    throw new ConversationSyncError("scope");
  await client.query(`alter table zcode_sync.configuration add column monitoring_started_at timestamptz not null default now();
    create table zcode_sync.observations(
      hour timestamptz not null, action text not null check(action in ('checkpoint','file_upload','file_read','continuation')),
      outcome text not null check(outcome in ('succeeded','rejected','failed','waiting')),
      reason text not null check(reason in ('none','checkpoint_limit','transport_limit','subject_capacity','version_limit','integrity','scope','schema','storage','invalid','blocked','stale','not_found','unavailable','changed','forward_only','conflict','busy','capability','required_skill','model','files','cancelling')),
      count bigint not null check(count>0),last_observed_at timestamptz not null,
      primary key(hour,action,outcome,reason));
    grant select,insert,update on zcode_sync.observations to zcode_sync_runtime;
    grant select on zcode_sync.observations to zcode_sync_configurator;
    grant usage on schema zcode_sync to zcode_sync_observer;
    grant select(tenant,subject) on zcode_sync.sessions to zcode_sync_observer;
    grant select(tenant,subject,session) on zcode_sync.versions to zcode_sync_observer;
    grant select(tenant,subject,bytes) on zcode_sync.payloads,zcode_sync.file_objects to zcode_sync_observer;
    grant select(result_json) on zcode_sync.continuations to zcode_sync_observer;`);
  for (const table of ["sessions", "versions", "payloads", "file_objects", "continuations"]) {
    await client.query(`create policy observer_aggregate on zcode_sync.${table} for select to zcode_sync_observer using(true)`);
  }
  // No dynamic SQL, identifiers or body columns. Only this fixed projection is executable.
  await client.query(`create function zcode_sync.capacity_summary(max_subject bigint,max_versions bigint)
    returns jsonb language sql stable security definer set search_path=pg_catalog,zcode_sync as $$
    with usage as (select tenant,subject,sum(bytes)::bigint as bytes from (
      select tenant,subject,bytes from zcode_sync.payloads union all
      select tenant,subject,bytes from zcode_sync.file_objects) u group by tenant,subject),
    versions as (select tenant,subject,session,count(*) as count from zcode_sync.versions group by tenant,subject,session)
    select jsonb_build_object(
      'sessions',(select count(*) from zcode_sync.sessions),
      'versions',(select count(*) from zcode_sync.versions),
      'subjects',(select count(*) from usage),
      'checkpointBytes',(select coalesce(sum(bytes),0) from zcode_sync.payloads),
      'fileBytes',(select coalesce(sum(bytes),0) from zcode_sync.file_objects),
      'files',(select count(*) from zcode_sync.file_objects),
      'largestSubjectBytes',(select coalesce(max(bytes),0) from usage),
      'subjectsAtCapacity',(select count(*) from usage where bytes>=max_subject),
      'largestCheckpointBytes',(select coalesce(max(bytes),0) from zcode_sync.payloads),
      'largestSessionVersions',(select coalesce(max(count),0) from versions),
      'sessionsAtVersionLimit',(select count(*) from versions where count>=max_versions),
      'unfinishedContinuations',(select count(*) from zcode_sync.continuations where result_json is null or result_json->>'status' in ('forward_only','cancelling'))
    ) $$;
    revoke all on function zcode_sync.capacity_summary(bigint,bigint) from public;
    grant execute on function zcode_sync.capacity_summary(bigint,bigint) to zcode_sync_configurator;`);
  // The restricted function owner gets column-only privileges and dedicated RLS policies.
  // Temporary membership/schema CREATE are confined to this trusted migration transaction.
  const membership = await client.query("select pg_has_role(current_user,'zcode_sync_observer','MEMBER') as member");
  if (!membership.rows[0].member) await client.query("grant zcode_sync_observer to current_user");
  await client.query("grant create on schema zcode_sync to zcode_sync_observer");
  await client.query("alter function zcode_sync.capacity_summary(bigint,bigint) owner to zcode_sync_observer");
  await client.query("revoke create on schema zcode_sync from zcode_sync_observer");
  if (!membership.rows[0].member) await client.query("revoke zcode_sync_observer from current_user");
}

/** Same metadata-only role as capacity_summary; no new raw read permission. */
export async function migrateUsageProjection(client: PoolClient) {
  await client.query(`create function zcode_sync.usage_summary(
    selected_tenant uuid, selected_subject uuid, excluded_tenant uuid, page_offset int, page_limit int)
    returns jsonb language sql stable security definer set search_path=pg_catalog,zcode_sync as $$
    with scoped as (
      select tenant,subject,bytes, true as checkpoint from zcode_sync.payloads
      union all select tenant,subject,bytes,false from zcode_sync.file_objects
    ), grouped as (
      select case when selected_tenant is null then tenant else subject end as key,
        sum(bytes)::bigint as bytes,
        coalesce(sum(bytes) filter(where checkpoint),0)::bigint as checkpoints,
        coalesce(sum(bytes) filter(where not checkpoint),0)::bigint as files,
        count(distinct (tenant,subject)) as subjects
      from scoped where (selected_tenant is null or tenant=selected_tenant)
        and (selected_subject is null or subject=selected_subject)
        and (excluded_tenant is null or tenant<>excluded_tenant)
      group by 1
    ), page as (select * from grouped order by bytes desc,key offset page_offset limit page_limit)
    select jsonb_build_object('observedAt',transaction_timestamp(),
      'total',(select count(*) from grouped),
      'totalBytes',(select coalesce(sum(bytes),0) from grouped),
      'items',(select coalesce(jsonb_agg(jsonb_build_object('key',key,'bytes',bytes,
        'checkpointBytes',checkpoints,'fileBytes',files,'subjects',subjects)
        order by bytes desc,key),'[]'::jsonb) from page)) $$;
    revoke all on function zcode_sync.usage_summary(uuid,uuid,uuid,int,int) from public;
    grant execute on function zcode_sync.usage_summary(uuid,uuid,uuid,int,int) to zcode_sync_configurator;`);
  const membership = await client.query("select pg_has_role(current_user,'zcode_sync_observer','MEMBER') as member");
  if (!membership.rows[0].member) await client.query("grant zcode_sync_observer to current_user");
  await client.query("grant create on schema zcode_sync to zcode_sync_observer");
  await client.query("alter function zcode_sync.usage_summary(uuid,uuid,uuid,int,int) owner to zcode_sync_observer");
  await client.query("revoke create on schema zcode_sync from zcode_sync_observer");
  if (!membership.rows[0].member) await client.query("revoke zcode_sync_observer from current_user");
}
