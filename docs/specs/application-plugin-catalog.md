# Optional application plugin discovery projection

Trusted application assembly may supply a discovery catalog for explicitly named
marketplaces. The application catalog service owns publication and presentation
group; native remains the only owner of installation, enablement and runtime.

- `catalog.marketplaceIds` selects only application-managed source identities.
- `catalog.entries` contains currently published native plugin IDs and their
  `public` or `community` group. Unlisted IDs in those marketplaces are excluded
  from discovery, including internal dependencies and retired entries.
- Loading or unavailable application catalog data does not expose unconfirmed
  managed entries. Personal sources outside this set keep native behavior.
- This projection applies to browsing, search and discovery detail. Installed
  management retains all native entries so existing user state remains manageable.
- Optional `beforeAcquire` checks the current application decision before an
  install, restore or update. It grants no resource permission or host capability.
- `renderCommunity` supplies authorized application-owned community cards through
  the same context as existing public / personal renderers.
- Optional `count(segment, query)` provides the external result count for the same
  query, so composed search totals and empty states describe all visible results.
- Both storefront and installed-management updates recheck `beforeAcquire`.
  A native position change while that asynchronous check is pending cancels the
  old acquisition before it enters the current position's native store.
- Source grouping respects `publisherType` for added public marketplaces instead
  of treating every item in them as the public group.
- No assembly preserves existing native discovery and operations. Failed or
  changed assembly never switches a remote operation to a local position.

Regression evidence covers managed hide / republish, community grouping, private
source preservation, no assembly, installed management and acquisition rejection.

## Bilingual display names

Application catalog entries may carry `nameZh` and `nameEn`, distinct from native
plugin IDs. The discovery projection overlays store listing display names for
search, cards and detail, without modifying source manifests or installed state.
Chinese locale uses Chinese as the primary title and English as a secondary label;
other locales use English first. Missing legacy names keep native display behavior.
Refresh replaces the projection from the server; older account results remain
discarded by the application adapter. Installation and version identities never change.
