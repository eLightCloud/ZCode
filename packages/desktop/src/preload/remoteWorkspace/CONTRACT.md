# Remote workspace preload adapter

This adapter owns the existing remote connect, attachment, cancellation, bind result decoding and session notification IPC forwarding. Main and the original remote service remain the identity and lifecycle owners. The factory preserves all existing channels, payload fields, error code/retryable metadata and listener disposal; it adds no session cache, retry or execution route. The main preload entry assembles this public adapter with other platform capabilities.
