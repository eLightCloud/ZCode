# Restore Legacy Sessions Plugin

ZCode official plugin for restoring old ACP-era ZCode session snapshots into the new task index and CLI session DB.

This plugin is bundled as `restore-legacy-sessions@zcode-plugins-official` and is disabled by default. Enable it only when you need to inspect or restore old session data.

## Enable

```sh
zcode plugins enable restore-legacy-sessions
```

Or inside a ZCode session:

```text
/plugins enable restore-legacy-sessions
```

Changes apply to new sessions. After enabling, use:

```text
/restore-legacy-sessions
```

## Data Boundaries

- Default source: `~/.zcode/v2/sessions`
- Task index destination: `~/.zcode/v2/tasks-index.sqlite`
- CLI session DB destination: `~/.zcode/cli/db/db.sqlite`

The restore scripts create timestamped DB backups before writing. Restored ACP-era conversations are persisted as normal `glm` ZCode Agent history and do not write `migration_source`.

This legacy writer supports targets before session migration `0026_portable_context_writer` only. Apply rejects 0026 or newer targets with `legacy_restore_target_requires_current_writer` before creating backups or modifying either database. Inspection and dry runs remain available. Do not register a writer capability function or remove the protection triggers to bypass this check.

Restore into an independent, stopped pre-0026 schema copy, check the restored history with its matching reader, then let the current native owner perform the normal forward migration on that copy. Keep the original snapshot independent; an older binary must not write the upgraded database. This flow does not make direct restore into a current live database supported.

## Development

This is a skill-only / command-only plugin. It has no MCP server and no build step.
