# Optional application admission

ApplicationDialog accepts an optional content className for application-sized forms;
native focus trapping, Escape, accessible title and overlay behavior remain owned by the shared dialog.

When application peripherals disable native cloud with `nativeCloudEnabled: false`,
the shared settings/profile menu omits the native Coding Plan upgrade action.
Usage statistics remain available. Unconfigured native builds retain the action.

## Trusted application pages

Root may receive build-owned applicationPages (stable id, label, optional Icon, render callback).
The first page trigger belongs to the native workspace header immediately before
Help, with a tooltip and accessible label. ApplicationPages provides that trigger
to the mounted workspace through context; it does not position a floating button.
The optional icon comes from the trusted assembly, without business semantics in
the shared shell. Static localized product copy can be supplied through
ApplicationBrand.localizedMessages; native terminology remains the default.
Curated builtin skill descriptions in the `/` and `$` menus use the configured
localized application name, falling back to the application name. This is a
display projection only: skill names, paths, source content and insertion payloads
remain unchanged. Third-party descriptions and historical restoration source
references retain their wording. Without a brand, native descriptions remain.
The callback receives the current native workspace reference and rpcReady state;
its service provider resolves the same workspace route. An offline remote target
must never fall back to local services. This context is navigation, not authority.
The generic UI owns opening, selection, refresh generation, closing and a scoped
error boundary. Pages render under existing service, platform and theme providers.
They cannot configure RPC, claim an execution input or infer authorization from
workspace context. Closing restores the mounted native workspace; refresh remounts
only the selected page. Removing a descriptor closes its page. The shell records
only page identity and lifecycle, never business content. Builds without descriptors
retain ordinary native UI. Mobile uses the same page contract and accessible
navigation, with no desktop-only service inferred. Business pages and permission
checks remain in the trusted external assembly, outside the generic UI repository.

## Optional application onboarding introduction

`ApplicationBrand.onboardingIntroduction` may enable a leading introduction in
the existing occupation onboarding. Unconfigured builds retain the original three
steps. Configured builds show introduction, occupation, interface mode and
preferences, with the same native layout, controls and completion record. Copy is
supplied through `localizedMessages` under `occupationOnboarding.introduction*`
and `occupationOnboarding.stepIntroduction`; no application or tenant policy is
hardcoded in the shared UI. The introduction has no editable preference.

Next or Skip on the introduction goes to occupation without saving or clearing an
answer; Back on occupation returns to the introduction. Close and reopening use
the existing onboarding owner and completion/dismissal rules. No second completion
flag, storage schema or unconditional replay is introduced. Telemetry counts the
displayed steps, reports introduction exposure once per opening, and does not
report an unseen occupation as an answer when closing on the introduction.

Full-page application navigation uses the selected page button as its visible title;
the dialog retains an accessible title and focus target. Navigation must clear macOS
traffic lights and reuse desktop overlay window controls on Windows and Linux.
Ordinary Web retains the same navigation without desktop window controls. Active
page selection is visible, and refresh uses an icon with a localized accessible name.

The admission hook receives route `server` or `native-cloud` before any Web route
restores credentials or opens a transport. It may return false after rendering an
explicit unavailable view; undefined preserves native routing. The application
assembly can decline native cloud login, remote relay and share routes without
replacing native personal API model settings or changing unconfigured builds.

An application-owned Root rejects native login requests with a localized explanation,
marks the attempt failed and clears that exact request. Requests from provider
settings or cloud features cannot remain silently pending or invoke native OAuth.
No vendor credential or model entitlement is inferred from application admission.

A trusted build assembly may configure an absolute ZCODE_APPLICATION_ROOT_MODULE.
It supplies ApplicationRoot through the existing public UI Root contract and may
export prepareApplication({ render }). The Web host owns its React root and awaits
this admission hook before the ordinary server bootstrap and native RPC connection.
No configured module preserves native startup. The hook owns application admission
only; it does not own native tasks, queues, provider credentials or execution.

ZCODE_APPLICATION_NATIVE_API optionally selects a trusted development proxy target
for server-info, native locations, host capability and WebSocket ingress. HTTP and
WebSocket forwarding preserve caller Origin; credentials never become Vite define
values. The default remains the original local native server. Runtime URL/query
parameters cannot configure this proxy. The assembly must provide production
same-origin routing separately; development Vite configuration is not deployment.

The enterprise assembly validates its local-account session before admission. The
trusted ingress revalidates session and instance grant, forwarding native bytes
without translating protocol, accepted input, replay or persistence. Instance
credentials remain server-side. Losing admission closes access; a successful new
application login must establish a fresh transport rather than reuse a revoked one.

The trusted build may set ZCODE_APPLICATION_API_PREFIXES to additional comma-separated
single-segment /api prefixes at the account proxy target. Native ingress prefixes
are reserved. These development routes preserve Origin and are never configured
by query strings or client payloads; production needs same-origin server routing.

Verify no-configuration startup, native remote recovery, malformed target rejection,
real local login before RPC, logout/revocation and new-login transport establishment.

## Optional application catalog section

Root.applicationPluginStoreSection adds one build-owned segment after Public and
Personal in the existing store. It supplies label, marketplaceIds, onRefresh and
render. The native store owns selection and query; render receives query plus the
current native workspace / RPC availability, under that location's service provider.
Application sources are excluded from Personal discovery, while the installed strip
continues to show the actual native inventory. Search in the application segment
uses the same query input and remains within its authorized catalog. Refresh asks
the application owner to reload alongside native inventory refresh. A removed
section returns selection to Public. The application owns its authorized projection,
loading / empty / error feedback and business install constraints, through public
services. The generic shell never fetches tenant data or changes install authority.
Unconfigured builds retain the existing two segments and cross-native search.

## Optional application Host module

A trusted Node launcher may set an absolute `ZCODE_APPLICATION_HOST_MODULE`. Its
`createApplicationHost({ native, credentials, storageRoot })` factory supplies one
application-owned `call(method, input)` facade and an awaited `dispose()` lifecycle.
The generic `application-host` service transports bounded application requests.
Unconfigured builds return an explicit unavailable error and never load a module.
Only the startup environment selects code; RPC cannot select modules or paths.
The module uses public native services and its own application storage directory;
no native session, execution or queue tables are exposed. Shutdown first disposes
application work, then native services. The channel logger records method/outcome
only; arguments may carry short-lived admission capabilities and must stay private.

## Application input preparation failure boundary

Optional input preparation is bounded to five seconds, receives an AbortSignal and
never edits the native envelope. Timeout, cancellation and extension failure leave
the original native command available; no late callback may assign a new producer.
Application observation may recover original intents under a newly verified context
of the same stable owner; it never reassigns the original context or operation key.
External source imports use the trusted application assembly resolver in both real
Vite and tests. The application source directory participates in file watching.

Native file download opens its destination through IPlatformService before reads.
The platform owns streaming or bounded buffered transport, cancellation and the
completed versus initiated outcome; shared UI only supplies authorized byte reads.

A configured renderDeliverables supplies the complete delivery body, including
source download while the copy is pending and accepted-copy actions afterwards.
It replaces the default native delivery body; without the slot, native source
download remains unchanged. This prevents presenting a released source snapshot
as downloadable after a durable application copy has been accepted.
