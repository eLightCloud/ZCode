# Application HTTP platform port

The application renderer supplies only a relative API path, method, bounded bytes and request ID.
Main owns the fixed startup destination, allowed API prefixes, current cookie jar and CSRF metadata.
Neither requests nor responses contain a credential/header override. Response headers are a
reviewed public subset, never Set-Cookie. Cancellation is scoped to the originating sender and ID.
This is an optional IPlatformService capability; Web keeps its existing same-origin HTTP path.
It grants no identity, tenant, tool, execution or business permission. The service remains the
authority for those decisions. No redirect or certificate bypass is part of this contract.
