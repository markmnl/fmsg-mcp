# Web API token providers

`FmsgClient` accepts either the existing `fmsgk_…` API-key string or a `TokenProvider`.
This is a client-library extension point. The MCP executable uses it for API keys and
optional [HTTP OAuth](oauth.md), including discovery, JWT validation and RFC 8693 exchange.

Import `TokenProvider`, `TokenProviderRequest` and `AccessToken` from
`@markmnl/fmsg-mcp/client` (also exported from the package root):

```ts
interface TokenProvider {
  getToken(request: {
    apiUrl: string;
    signal: AbortSignal;
    forceRefresh: boolean;
  }): Promise<{
    accessToken: string;
    address: string;
    expiresAtMs: number;
  }>;
  close?(): void;
}
```

Supply an implementation as `new FmsgClient(apiUrl, tokenProvider, options)`.
One provider and client belong to one caller, authorization grant and Web API URL.
Sharing a provider between clients risks mixing grants or closing another client's credentials.

## Provider responsibilities

- Obtain a fresh **Web API** bearer access token whenever called. `apiUrl` is the
  normalized, fixed upstream URL; never derive credential destinations from model input.
  `forceRefresh: true` means the previous token was rejected with 401 or renewal was
  explicitly requested. It must bypass any provider cache of that rejected token.
- Return the authenticated fmsg address that the token authorizes, preserving user-name
  case, and a finite future expiry in milliseconds since the Unix epoch. Use trusted
  authorization/exchange metadata; do not invent an expiry or infer identity from an
  unverified incoming token. The generic client does not decode provider tokens.
- Honour `signal` for all network work. It aborts when renewal times out, the client
  closes, or all callers waiting for that renewal cancel. Reject on failed/revoked
  authorization; never fall back to an owner token, API key or another grant.
- Keep credentials out of errors and logs. `close()` synchronously releases retained
  credentials/resources; it is called once when the owning client closes. Closing a
  client is local cleanup, not remote OAuth-grant revocation.

## Client responsibilities

The client caches immutable token snapshots and shares concurrent renewal. It renews
five minutes before expiry by default, capped at half the remaining lifetime when the
token is acquired, so a one-minute token is usable without constant re-exchange.
`refreshMarginMs: 0` disables early renewal, but never permits an expired cached token.
Each acquisition has the client's `timeoutMs` budget (60 seconds by default).

The first successful acquisition pins the address. A renewal for another address is
rejected before any request uses that token; changing identities requires a new client.
This is caller binding, not an additional messaging permission system. The Web API
still validates the actual credential, identity, scopes, visibility and host limits.

Protected HTTP requests retry once on 401 after renewal. Concurrent or late 401s for
the same old token reuse an already renewed token; 403 never triggers renewal.
Failed renewal discards the cache. Provider output must be a bearer token with a valid
address and expiry; an API key passed back as an access token is rejected.

`getToken(force?, signal?)` and `address(signal?)` support cancellation, as do existing
request methods that accept a signal. Cancelling one waiter leaves renewal available
to others; cancelling the last aborts acquisition. Late provider completion cannot
replace a later token. `close()` aborts outstanding token acquisition and HTTP work.

`openFmsgWebSocket(client, signal?)` obtains its bearer from the same provider/cache.
The optional signal cancels token acquisition before opening the socket. The caller
owns the returned WebSocket and must handle its events and close it; long-lived
connections do not gain automatic token renewal or revocation handling from this helper.
`wait_for_message` owns its socket and passes cancellation into acquisition. With
`reconnectOnTokenExpiry: true`, it closes and reopens sockets by the token metadata expiry,
retaining the original wait deadline and cursor; OAuth mode enables this option.

## OAuth adapter contract

Validate the incoming MCP access token for the configured issuer and MCP audience,
then use authenticated [RFC 8693 token exchange](https://www.rfc-editor.org/rfc/rfc8693.html)
to obtain a separate upstream token. [MCP forbids passing the incoming token through
to the Web API](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations).
Keep issuer, JWKS/discovery URLs, audiences, address-claim mapping and client credentials
configurable; no particular identity provider is required by this interface.

The IdP and Web API must agree on scopes and consented-identity binding before hosted
OAuth is enabled. Exchanged messaging tokens must not acquire owner key-management
rights or broaden identity via `X-FMSG-Act-As`. The Web API enforces those restrictions;
the tool list is not an authorization boundary. Browser consent and refresh/revocation endpoints belong to the authorization service and host. Offline JWT validation alone does not
provide immediate revocation of already issued upstream tokens.

Tests in `test/token-provider.test.ts` use registered opaque token fixtures to exercise
renewal, cancellation, caller isolation, and HTTP/WebSocket credential delivery. They
do not establish OAuth conformance, JWT verification, or compatibility with a real IdP.
