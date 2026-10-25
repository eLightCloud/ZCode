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

## Paused creation and private application admission

`createAutomation({enabled:false,...})` creates a paused definition with no due
time. Omission keeps the existing enabled default. Only the native owner changes
its enabled state and computes the next due time; external configuration cannot
claim a run by writing the native database.

Paused absolute-schedule creation may carry a UUID `creationId`. It identifies
the native definition atomically; retry returns the same matching definition,
while changed creation parameters conflict. Relative-delay and interval carriers
are not accepted with this key. Enabling an initially paused definition computes
its first due time in the native service. Manual trigger may carry a UUID
`requestId`; its existing native manual run is returned without dispatching twice,
including after completion. No additional run ledger or execution queue is added.
`previewAutomation` uses the same schedule normalization as creation and validates
native model/schedule carriers without writing a definition. Its next time is a
preview from now, not the next-run fact of a still-paused definition.

The trusted launcher may receive a private Application Host control port. It is
never registered on the browser RPC service. Server exposes its bounded opaque
control calls only behind the private instance credential. A configured extension
may also check an automation input before task creation, using the native run ID
and the exact fixed dispatch configuration. It returns admitted, blocked, or
unavailable. Blocked is a permanent application admission failure; unavailable
retains native bounded retry. An absent extension or hook leaves native personal
automation unchanged. A configured malformed hook result cannot mean admitted.

```text
native claim → fixed model/config → optional private application admission
                                  ├ admitted → native task/input admission
                                  ├ blocked → native permanent failure
                                  └ unavailable → native bounded retry
```

Application-owned context references may bind to the native run/input ID before
dispatch, but may not mirror the native execution queue or terminal state. The
hook cannot rewrite input, model choice, claim or run identity. Test rejection
before createTask/sendPrompt, paused creation, private HTTP authentication and
ordinary automation with no application hook.

An admitted hook may supply one bounded text context attachment (16 KiB, safe
filename). It uses the existing native file-attachment input path and persists
with that exact run/input. The fixed prompt is unchanged. Context is application
data, never credentials or an authorization override; each resource owner still
checks current authority. A configured malformed attachment rejects admission.


### Optional application management supplement

The existing automation management view may render an optional launcher/application supplied
`renderAutomationSupplement` slot. The slot configures external business policy and queries native
control receipts; it does not claim, schedule or execute tasks. Without application assembly the
native view and its personal automation actions remain unchanged. The external service principal
must own its private Host. A management viewer receives business metadata only, never an implicit
conversation or file content grant. Unknown commands are queried by their original request ID.


The public read-only `getAutomationCapabilities` reports the current native timezone and whether
the Host has an immediate dispatch owner. A launcher application must not infer readiness from a
saved definition alone. In Server Core the native automation feature switch installs the dispatcher
and scheduler together; when disabled, applications may save draft business policy but must not
declare the Host ready or enable a business rule.

A launcher may inject an application admission secret as `ZCODE_APPLICATION_HOST_TOKEN`.
It belongs exclusively to the trusted Host extension. Native Agent process creation removes it
alongside the native listener credentials, including command-resolver environment overrides.
A resource/model credential passed to Agent adapters must not authorize private application
admission or source-proof renewal. Application deployments register distinct credential hashes.

Manual dispatch carries the saved projectId and additionalDirectories through the same dispatch request as scheduled triggers. A headless manual trigger must not drop project ownership or execution directories; callers cannot provide temporary replacements.
