# workspace-entry

Root.workspaceEntry renders the same native App and responsive sidebar without an attached workspace, path or session. The trusted caller supplies display content, pending UI state and an explicit preparation callback. No writable native call is made by rendering this state. Draft options are renderer-only and retain their original lease. Existing account, application-page, settings and focus owners remain in place. No new execution queue or persistence is introduced. See docs/design/deferred-workspace-entry.md.
