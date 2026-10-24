import type { PoolClient } from "pg";
import { ConversationSyncError, syncVersionSchema, type SyncVersion } from "@zcode/contracts";
import { digest } from "./canonical.js";
import type { VersionFacts } from "./transitions.js";
/** Assignment receipts are the existing authority; version labels cannot invent a grant. */
export async function assignedGenerations(
  client: PoolClient,
  session: string,
): Promise<Map<number, string>> {
  const result = await client.query(
    `select distinct value->>'location' as location,(value->>'generation')::bigint as generation
    from zcode_sync.receipts r cross join lateral jsonb_array_elements(jsonb_build_array(
      r.receipt#>'{state,active}',r.receipt#>'{state,pending}')) value
    where r.session=$1 and value->>'location' is not null`,
    [session],
  );
  const values = new Map<number, string>();
  for (const row of result.rows) {
    const generation = Number(row.generation);
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      (values.has(generation) && values.get(generation) !== row.location)
    )
      throw new ConversationSyncError("storage");
    values.set(generation, row.location);
  }
  return values;
}
export async function versionsFor(
  client: PoolClient,
  session: string,
): Promise<Map<string, VersionFacts>> {
  const result = await client.query(
    "select id,parent,location,generation,digest,management,files from zcode_sync.versions where session=$1",
    [session],
  );
  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        id: row.id,
        parent: row.parent,
        location: row.location,
        generation: Number(row.generation),
        checkpointDigest: row.digest,
        managementDigest: row.management === null ? null : digest(row.management),
        ...(row.files?.length ? { filesDigest: digest(row.files) } : {}),
      },
    ]),
  );
}
export async function readVersion(
  client: PoolClient,
  session: string,
  id: string,
): Promise<SyncVersion | null> {
  const result = await client.query(
    `select v.id,v.parent,v.location,v.generation,v.digest,v.management,v.files,p.payload
    from zcode_sync.versions v left join zcode_sync.payloads p using(tenant,subject,digest)
    where v.session=$1 and v.id=$2`,
    [session, id],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.digest !== null && (!row.payload || digest(row.payload) !== row.digest))
    throw new ConversationSyncError("storage");
  return syncVersionSchema.parse({
    id: row.id,
    parent: row.parent,
    location: row.location,
    generation: Number(row.generation),
    checkpoint: row.payload ?? null,
    ...(row.management === null ? {} : { management: row.management }),
    ...(row.files === null ? {} : { files: row.files }),
  });
}
