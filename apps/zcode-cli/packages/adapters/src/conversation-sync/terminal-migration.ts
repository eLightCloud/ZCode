import type { PoolClient } from "pg";

export async function migrateTerminalObservation(client: PoolClient) {
  await client.query(`create table zcode_sync.terminals(
    tenant uuid not null,subject uuid not null,source text not null,
    source_ref text not null check(source_ref ~ '^[a-f0-9]{64}$'),
    kind text not null check(kind in ('desktop','server')),
    sequence bigint not null check(sequence>0),received_at timestamptz not null,
    snapshot jsonb not null,primary key(tenant,subject,source));
    alter table zcode_sync.terminals enable row level security;
    alter table zcode_sync.terminals force row level security;
    create policy subject_scope on zcode_sync.terminals to zcode_sync_runtime
      using(tenant::text=current_setting('zcode_sync.tenant',true) and subject::text=current_setting('zcode_sync.subject',true))
      with check(tenant::text=current_setting('zcode_sync.tenant',true) and subject::text=current_setting('zcode_sync.subject',true));
    grant select,insert,update on zcode_sync.terminals to zcode_sync_runtime;
    create policy platform_observation on zcode_sync.terminals for select to zcode_sync_configurator using(true);
    grant select(source_ref,kind,sequence,received_at,snapshot) on zcode_sync.terminals to zcode_sync_configurator;
    create index terminals_received on zcode_sync.terminals(received_at desc);`);
}
