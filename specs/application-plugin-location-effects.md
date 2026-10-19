# Application plugin location effects

Trusted application assembly may supply `renderLocationEffect` on the existing
application plugin store section. Root mounts this optional effect through the
same `ApplicationPageContent` workspace/service resolution used by application
pages, independently of opening the marketplace. With no extension, native
behavior is unchanged.

The callback receives only the current workspace target and RPC readiness. It
does not gain another installation store or execution controller. The application
uses public plugin services for reconciliation and cancels stale work when the
workspace, remote session, identity or readiness changes. A disconnected remote
location must never resolve to local installation.

```mermaid
sequenceDiagram
    participant R as Native Root / workspace resolver
    participant A as Trusted application effect
    participant S as Public plugin service
    participant C as Application catalog owner
    R->>A: Current target and readiness
    A->>C: Current authorized desired content
    A->>S: Install/update exact content at that target
    S-->>A: Native actual installed/enabled
    R->>A: Target changes or disconnects
    A->>A: Cancel stale future mutations
```

Acceptance: effect mounts outside marketplace navigation; absent extension has
no effect; the existing resolver supplies workspace identity and remote session;
stale targets stop mutation; enabled choices stay native-owned. Application
reconciliation must use immutable package revisions so existing runs retain their
previous native package paths. Desktop and web use this same projection; this
extension adds no execution transport, queue or recovery state.
