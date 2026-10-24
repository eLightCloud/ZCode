# Runtime idle maintenance

The protocol runtime owns maintenance admission through its existing SessionResidentPool.
It does not create another command inbox or copy execution state into a host.

`process/idleMaintenance` accepts a UUID operation and begin/status/cancel. Begin checks
the existing residency facts: active protocol operations, deactivation, persisted sessions,
runtime-owned detached/background work, finalization, pending interactions, queued/in-flight
commands and subscribers. Unknown or busy is blocked. A successful begin closes operation
admission before awaiting anything and deactivates only eligible resident apps through the
existing owner. The CLI process, durable sessions and settings remain. Retiring the idle apps
also disposes their future timers; merely observing an idle turn does not do this.

The same operation can query/retry. Another operation cannot release the gate. Normal
requests remain rejected while held. Successful cancel reopens admission after every app
close is confirmed; an unconfirmed close keeps the gate closed. The process exits naturally
with its host; Server Core maintains the durable outer operation across Core restarts.

```text
deployment prepare → observer disconnect → Core HTTP admission barrier
  → local service lifecycle port → CLI resident-pool admission barrier
  → existing app retirement → held receipt
  → finish API HTTP drain / update → same-operation release
```

The service lifecycle port is delivered only to the trusted local constructor callback,
never installed as a remotely callable AgentService method. WebSocket RPC counts unsettled
calls even after disconnect; closing a socket is not proof its admitted service call settled.
Automation-enabled Core instances remain blocked until their scheduler has a verified pause
contract. No forced stop, replay, data rewrite or migration is part of maintenance.

The durable Server CLI entry currently advertises maintenance on POSIX platforms.
Windows directory durability is not yet validated; it advertises no maintenance
capability and rejects before closing admission. Other lifecycle commands retain
their existing platform contract.
