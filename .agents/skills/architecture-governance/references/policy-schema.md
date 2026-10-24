# Policy schema

`architecture-policy.yaml` contains `version: 1`, a list of modules, global thresholds, and optional exceptions.

Each module has an `id`, one or more `roots`, optional `managed: true`, `requires`, `provides`, `publicEntrypoints`, and an optional `owner`. Existing modules may remain unmanaged while they are in baseline migration.

Global keys: `maxFileLines`, `maxContractLines`, `maxPublicMethods`, `forbidCycles`, `forbidDeepImports`, `managedOnly`, `newFilesRequireManagedModule` (default true), `newFileScopes` (default `[packages, apps]`) and `newFilesEnforcedSince` (date; tracked files first added before it are not subject to `unmanaged-new-file`, untracked files always are). Canonical layer names are `contract`, `domain`, `app`, `adapters`, `ui`; `layerOrder` lists them from lowest to highest and a layer may only import lower layers.

The policy owns path and layer topology. A module's `module.ts` owns its local dependency declaration. Do not add a second hand-maintained dependency graph.

`global.acceptedUpstreamCommits` optionally records reviewed upstream admissions as `{ commit, previousHead, reason }`. Both hashes must be full commit SHAs already merged into HEAD. Only paths introduced by that upstream relative to `previousHead`, with identical Git content and modes in both index and working tree, are exempt from `unmanaged-new-file`. Local additions, edits, renames, untracked files and later edits of previously admitted files remain subject to module registration. Other architecture rules and the real push/CI diff scope are unchanged. See `docs/architecture/architecture-governance.md` for the admission contract.

`global.acceptedUpstreamSnapshot` optionally points to a generated repository-relative JSON manifest for a separately exported Git history. It is mutually exclusive with nonempty `acceptedUpstreamCommits`. The manifest records public source paths, fixed Git blob IDs and modes, introduced paths, and historical source snapshots from before the enforcement date; both index and working tree must still match. Historical snapshots only preserve the original date scope and do not admit lint diagnostics. It does not admit changed content or waive other rules. See `docs/testing/opensource-export-validation.md` for export generation and regression requirements.

A `layers` entry accepts either one repository-relative path from each module root or a nonempty array of such paths. Use an array when the same actual layer owns several separate source files; this avoids moving unrelated responsibilities or classifying the whole directory at the highest layer. Existing string entries keep exactly the same meaning. Every mapped path participates in the same layer-direction and domain-IO checks, with the longest path still winning. Empty arrays and non-string entries are invalid; this does not add an exception or change thresholds, baseline, admission or layer order.
