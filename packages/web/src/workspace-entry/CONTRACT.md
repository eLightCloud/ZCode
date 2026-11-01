# web-workspace-entry

Reuses the existing disconnected home-only service adapter for native workspace entry and mobile remote home. The disconnected adapter itself starts no transport or execution provisioning. A trusted application may inject reads from a previously authorized host and hand off a selected native task. Explicit file and other unsupported writes reject; no synthetic workspace or session is created. Locale is supplied by the caller. Native bootstrap remains the single connection owner. See docs/design/deferred-workspace-entry.md.

The navigation port only opens an accurately restored conversation. Drafts cross reload in navigation state after same-owner verification, never in the URL or logs. Arrival rechecks scope and writes through the existing native draft owner; no implicit send or execution permission is created.
