/** Native per-location admission and exact operation recovery; not a center lease. */
export const SESSION_CONTINUATION_MIGRATION_SQL = `
create table session_continuation (
  session_id text primary key,
  operation text not null,
  state text not null,
  generation integer not null default 0,
  version text,
  digest text,
  staged_json text
);
create table session_continuation_receipt (
  session_id text not null,
  operation text not null,
  kind text not null,
  fingerprint text not null,
  result_json text not null,
  primary key(session_id, operation, kind)
);
`;
