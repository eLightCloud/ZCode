# Native scheduler transport separation

## Failure and diagnostic contract

Desktop and Server use the same native dispatch failure classifier. Unknown errors
are transient and retain native bounded retries. Only explicit native configuration
errors (unresolvable model selection or a target owned by another Host) are permanent.
Classification never guesses from an exception message. Scheduled permanent failure
disables the rule; failed manual admission releases its claim without changing cron.

Outcome, claim, unread and delivery failures carry stable event/reason fields and
runId/automationId at their owning operation. Scheduler messages carry optional
structured diagnostics; Desktop retains its human-readable logs, and Server logs
only those low-sensitivity fields, never raw errors, prompts or workspace paths.
Public node exports expose scheduler, dispatcher, protocol and the manual failure
operation actually used by hosts; internal settlement helpers are tested by session.

The existing native scheduler algorithm owns polling, durable claims, misfire,
manual wake, dispatch settlement, retry and interrupted off-peak recovery. Extract
that algorithm into the native session module and export it through services/node.
Desktop remains a thin Electron parentPort adapter; it must not retain a second
copy of the algorithm. Protocol, settlement helpers and resource sampling follow
the same owner. Desktop consumes the public scheduler/dispatcher/protocol directly;
session tests cover the internal helpers without Desktop import shims.

The public startAutomationScheduler({ postMessage, databasePath? }) returns ready, acceptMessage,
and dispose. postMessage transports the existing native control messages without
changing their shape. Optional `offPeakEnabled: false` leaves off-peak records,
claims and recovery untouched when that host has no off-peak dispatcher. Desktop
keeps the default enabled behavior. Dispatch success continues to mean input admission, not turn
or business-result completion. The hosting process owns transport and termination.
The scheduler library never exits its host process. Disposal stops polling and
sampling, waits for an active tick, releases its owned claims and closes its repos.

Each isolated data root must have one hosting scheduler. Supervisor or Desktop
main provides this process lifetime; do not create a per-chat scheduler. Off-peak
startup recovery assumes that previous scheduler process is no longer running.

Headless validation uses the same exported algorithm, real native SQLite and native
control messages with an explicitly controlled dispatch consumer. It proves that
the scheduler does not require Electron. It does not prove Agent execution, model
availability, enterprise service identity, notification or a server shutdown daily
report. Server Core activation waits for a validated native dispatch/turn owner;
do not claim rules with an unimplemented dispatcher or create enterprise cron.

The native services/node `createAutomationDispatcher` owns the shared Desktop and
Server task dispatch and exact-input terminal subscriptions. Hosts supply target
services and delivery mode; they do not copy model resolution or outcome logic.
Subscribe before sendPrompt, preserve runId as inputId, and freeze the model in
the existing run record. A terminal for another input must not settle the run.
Dispose drains admissions and outcome writes before closing the owning Repo.

Server Core enables this path only with trusted startup configuration
`ZCODE_SERVER_AUTOMATION_ENABLED=1`. One Core per native data root owns the native
scheduler. Manual requests dispatch their already-claimed native run through the
same dispatcher, without overriding saved input. Server uses replayable delivery
and rejects targets requiring a different remote Host. Its off-peak path stays
disabled. Shutdown drains dispatch and scheduler acknowledgements before stopping
Agent services. Runtime recovery, enterprise service identity and external
business effects still require separate verification.

```text
native SQLite claim → scheduler → host target services → shared dispatcher
                                            ├→ CLI admission (runId/inputId)
                                            └← exact-input terminal → SQLite outcome
```

Verify scheduled and manual dispatch, successful admission settlement, failed
dispatch/claim release, wake, graceful shutdown, restart and existing Desktop
manager/telemetry tests. Persisted automation semantics and native interval remain
unchanged. Generic transport separation must contain no enterprise business names.
