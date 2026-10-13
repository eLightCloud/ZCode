# Optional standalone instance authentication

Core HTTP and WebSocket endpoints share instance Bearer authentication. A listener
outside loopback requires explicitly configured authentication before binding.
Default loopback operation without a credential keeps native behavior.

A managed deployment supplies ZCODE_SERVER_AUTH_TOKEN_SHA256 (64 hexadecimal
characters), computed from a high-entropy opaque credential held by its trusted
ingress. Core and Supervisor receive only the digest. Each submitted Bearer is
hashed and compared in constant time. The digest itself is not a usable credential.
This prevents same-user commands from retrieving the credential from /proc process
environments. Remove both authentication configuration fields from Agent children.

The original optional ZCODE_SERVER_AUTH_TOKEN remains supported for personal native
configuration. Configuring both forms is an error, not precedence or fallback.
Neither form grants employee identity, tenant authorization or resource permission.
Managed deployment uses only digest configuration and separately authenticates its
application users. Do not return credentials or digest configuration in server-info.

Verify malformed/ambiguous configuration rejection, unauthenticated HTTP/WS,
authorized native protocol, wrong credential, digest-as-credential rejection,
managed process environment inspection, current user revocation and native defaults.
