# Main application HTTP owner

Only the packaged application's exact top-level renderer (or the exact configured development
renderer) can invoke the public platform port. Main snapshots trusted startup configuration,
fixes the HTTPS destination and explicit API prefixes (a native control subtree requires its own narrow prefix; instance RPC and platform administration remain rejected), supplies current cookies and CSRF, forbids redirects,
and returns bounded bytes with public response headers. Packaged HTTP and credential-bearing or
non-root endpoint URLs are rejected. Missing configuration stays unavailable.

Active requests are owned by sender and request ID, not by tenant or business state. Cancellation,
top-level navigation, renderer loss and destruction release them. A thirty-second transport deadline
and bounded in-flight requests limit resource use. These limits do not change test deadlines or
business admission. Low-sensitivity request events carry correlation ID, sender, outcome and status;
they omit URL parameters, credential values and payloads. The server still decides all authorization.

Native plugin HTTP acquisition can use the same Main cookie owner through an optional, startup-
configured read-only loopback broker. Startup fixes source origins and narrow path prefixes within
the existing application HTTP allowlist. Main creates a process-scoped secret in a private 0600
native credential file; it never exports account cookies. Only authenticated GET requests for those
prefixes are forwarded, with the current Main session on every request, bounded bytes, no redirects
and the existing deadline. Logout and account changes therefore apply to the next acquisition.
Initialization completes before creating the window/Host; failure leaves acquisition unavailable.
This transport owns no installation state, approvals, package cache or retry queue. Native plugin
management remains the sole installer. Shutdown revokes the listener and removes its private files.

`ZCODE_APPLICATION_PLUGIN_HTTP_SOURCES` is a trusted startup JSON array of `{origin,pathPrefix}`;
each prefix is a narrow two-segment API subtree within the existing HTTP allowlist. Configuration
also requires `ZCODE_APPLICATION_SESSION_COOKIES`, an allowlist of cookie names, never values.
Native receives only `ZCODE_PLUGIN_SOURCE_CREDENTIALS_FILE`. The broker uses Node fetch because
Electron session.fetch rejects an explicit application Origin; Main still reads current cookies.
`application.http.plugin_configuration` reports configured/unavailable. Each
`application.http.plugin_source` request reports correlationId, status, outcome and an optional
bounded admission/transport/response reasonCode, without URLs, payloads, cookies or capability tokens.
