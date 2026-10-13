# Optional application admission

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

Verify no-configuration startup, native remote recovery, malformed target rejection,
real local login before RPC, logout/revocation and new-login transport establishment.
