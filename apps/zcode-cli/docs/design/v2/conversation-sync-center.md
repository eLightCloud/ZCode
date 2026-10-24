# Conversation sync center — isolated development contract

## Scope and owner

The native conversation storage owner exposes `@zcode/adapters/conversation-sync`.
It owns immutable versions, scoped payload deduplication, operation receipts,
selection and handoff facts. Enterprise services supply authenticated scope and
resource authorization; they never inspect native SQLite or write conversation
rows. The first codec reuses `textCheckpointSchema`, with no second text DTO.
Unknown/non-text states remain unsupported; existing session/plugin/configuration
stores are never replaced by a center database. This is an additive schema.

The initial facade is for trusted local assembly and isolated verification. It
is not a public HTTP endpoint, nor proof of Desktop/Web input integration. Scope,
qualification and source barrier evidence must come from trusted native owners,
not from browser JSON. No activation receipt may be used as a runtime lease until
native admission and restore are wired. There is no timer-based takeover.

## Event order and durable boundaries

```mermaid
sequenceDiagram
  participant L as Native local owner
  participant O as SQLite sync outbox
  participant P as Native center / PostgreSQL
  L->>O: stage exact qualified checkpoint and stable operation
  O->>P: receive (same operation after loss)
  P-->>O: immutable saved receipt (no execution grant)
  O->>O: persist acknowledged watermark
  L->>P: promote with selection CAS and verified other-owner barrier
  L->>P: begin H (source, generation, B)
  L->>L: close admission and settle accepted work
  L->>P: grant H with C descendant of B and dependency evidence
  P-->>L: unique target generation; source remains fenced
  L->>L: target restores exact C, verifies readiness
  L->>P: activate matching target generation and C
```

Desktop continuous and mobile replayable remain existing delivery modes; this
storage facade neither accepts user input nor constructs a second input queue.
Offline immutable versions can always be received, including while H exists;
new candidates invalidate selection CAS. Normal deletion is a tombstone version,
not payload destruction. Choosing deletion needs no recovery package. A new late
successor of a resolved candidate becomes a new candidate; exact resolved copies
and known ancestors stay resolved. No merge, LWW, replay or compensation.

## Transactions and failures

Each session row is locked in one PostgreSQL transaction; all immutable payload,
version, state and receipt writes commit together. An operation ID is scoped to
subject+session; equal canonical input returns the original receipt, unequal
input rejects. Receipt retry precedes revision comparison. Rejected operations
leave no receipt or partial state. Scope uses transaction-local RLS context;
application roles must not be owner/superuser/BYPASSRLS. Native migration runs
with a separate deployment identity and serial advisory lock; unknown schema
versions reject. No enterprise Alembic owns this schema.

The outbox uses a separate SQLite file with an explicit native owner; no raw
session database access. Durable items are not command admission. Restarts retry
exact bytes/operation, acknowledgements are verified before advancing. Another
account cannot flush an old scope. Acknowledgement loss leaves the item pending.
The source scanner performs full startup/reconnect scans via the native public
checkpoint port. It rechecks directory qualification inside the supplied native
owner boundary, compares exact content with its durable local tip, and atomically
stages changes with the scan generation. Host integration must supply the real
per-session admission barrier; a scan generation is not a source commit sequence.
The separate SQLite file validates its application ID before any schema/WAL change.

## Handoff / selection transitions

- Receive is independent of selected head or active location.
- Promote requires linear ancestry, unchanged selection and proven no independent
  admission. It clears active eligibility; reload/activation must follow.
- Begin fixes B and source generation. Only that source's linear successors can
  become C. Grant checks all candidates are compatible, source barrier, exact
  revisions and dependencies. Unknown evidence rejects.
- Before grant cancel is final and advances source generation. After grant cancel
  returns `forward_only`; reverse transfer requires a new H after activation.
- Selection compares revision and exact candidate set. Every receive changes the
  revision, including a new descendant while selection is in flight. Selected
  data does not automatically activate; selecting deletion clears location.
- A selected ordinary tombstone cannot be promoted implicitly, even if a new
  text version names it as parent. Resuming requires explicit whole-copy choice.
- Historical handoff IDs remain unique through immutable operation receipts;
  later handoffs cannot make an old cancelled/granted H reusable.
- Permanent purge, physical TTL and unrestricted opening have no initial facade.
  Controlled-subject allowlists and measured limits are injected by a trusted
  configuration owner, never by env fallback or browser switches.

## Required evidence

Real restricted-role PG RLS, concurrent receipts and selection/grant races;
process-independent reopen and immutable payload checks; real SQLite outbox
reopen and lost-ACK retry; source SQLite import/export via its public facade and
cold resume regression; old source/plugin/config migration regressions unchanged.
Device/OS/host gates stay separate from local implementation progress.
