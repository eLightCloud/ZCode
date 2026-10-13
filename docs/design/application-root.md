# Optional application admission

## Trusted application pages

Root may receive build-owned applicationPages (stable id, label, optional Icon, render callback).
The first page trigger belongs to the native workspace header immediately before
Help, with a tooltip and accessible label. ApplicationPages provides that trigger
to the mounted workspace through context; it does not position a floating button.
The optional icon comes from the trusted assembly, without business semantics in
the shared shell. Static localized product copy can be supplied through
ApplicationBrand.localizedMessages; native terminology remains the default.
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
