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
