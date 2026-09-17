# HTTP OAuth

OAuth is an optional HTTP authentication mode. API-key HTTP and stdio remain available with
`FMSG_MCP_AUTH_MODE=api-key` (the default). Each endpoint uses one mode; run separate instances
if you need both. There is no API-key fallback in OAuth mode.

A user adds the public MCP URL to a compatible host, signs in with the configured authorization
server, and consents to messaging scopes. The host handles authorization-code/PKCE and refresh;
fmsg-mcp validates its access token and exchanges it for a separate Web API token. Users do not
need to create an fmsg API key for this connection. The MCP server's exchange secret belongs to
the operator and is never given to users or AI hosts.

## Operator configuration

Provision an OAuth resource and a confidential exchange client at your authorization server.
Use the exact same resource URI in its resource registration, MCP configuration and host setup.
The Web API must support [delegated OAuth claims](https://github.com/markmnl/fmsg-webapi/blob/main/docs/oauth-claims.md),
with distinct OAuth and owner audiences. Configure the IdP's exchange target to issue that OAuth
audience and the consented address, with `fmsg:read` and/or `fmsg:write`.

```sh
export FMSG_API_URL=https://api.example.com
export FMSG_MCP_AUTH_MODE=oauth
export FMSG_MCP_OAUTH_RESOURCE_URL=https://mcp.example.com/mcp
export FMSG_MCP_OAUTH_ISSUER_URL=https://idp.example.com/oauth
export FMSG_MCP_OAUTH_CLIENT_ID=fmsg-mcp
export FMSG_MCP_OAUTH_EXCHANGE_AUDIENCE=fmsg-webapi
export FMSG_MCP_ALLOWED_HOSTS=mcp.example.com
# Supply FMSG_MCP_OAUTH_CLIENT_SECRET through your service's secret manager.
# Leave FMSG_API_KEY unset.
npx -y @markmnl/fmsg-mcp --http 127.0.0.1:8765
```

| Setting | Required in OAuth mode | Meaning |
|---|---|---|
| `FMSG_MCP_OAUTH_RESOURCE_URL` | Yes | Exact public MCP URL, including `/mcp`; also the incoming JWT audience |
| `FMSG_MCP_OAUTH_ISSUER_URL` | Yes | Exact authorization-server issuer, including any path |
| `FMSG_MCP_OAUTH_CLIENT_ID` | Yes | This MCP server's confidential token-exchange client ID |
| `FMSG_MCP_OAUTH_CLIENT_SECRET` | Yes | Its exchange secret; sent only in HTTP Basic authentication |
| `FMSG_MCP_OAUTH_EXCHANGE_AUDIENCE` | Yes | Actual Web API OAuth audience; must differ from the MCP resource URI |
| `FMSG_MCP_OAUTH_ADDRESS_CLAIM` | No; `sub` | Incoming JWT claim containing the consented full `@user@domain` address |
| `FMSG_API_URL` | Yes | Fixed deployed Web API base URL |

Use the actual audience value for `EXCHANGE_AUDIENCE`, even if the IdP also supports target
aliases: fmsg-mcp checks the returned JWT audience against this value. In the example the Web API
and IdP target must both use `fmsg-webapi` as their OAuth audience. The outgoing token's `sub`
must equal the incoming consented address; its issuer/signature are validated by the Web API.
If your IdP stores a hash of the exchange secret, provision its SHA-256 there and give the original
secret to this server. Never put the secret in source control or client configuration.

OAuth URLs require HTTPS, with HTTP permitted only on loopback for local testing. Discovery,
JWKS and exchange requests refuse redirects and have a five-second/64-KiB response budget.
Configuration is vendor neutral, but authorization servers must implement the token profile below;
an arbitrary OAuth provider without token exchange is not sufficient.

Use the [TLS deployment recipe](http-deployment.md), including its metadata routes. Browser hosts
on other origins need `FMSG_MCP_ALLOWED_ORIGINS`. The configured resource origin is accepted as
same-origin behind a TLS proxy; forwarded headers never select an issuer, resource or token endpoint.

## Discovery and client onboarding

Public [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html) metadata is served at
`/.well-known/oauth-protected-resource` and the resource-specific path
`/.well-known/oauth-protected-resource/mcp`. Both advertise the exact configured resource,
authorization server, supported scopes and header bearer authentication. A resource served under
another public path requires the corresponding metadata path to reach this process too.
Unauthenticated or invalid-token requests receive `401` with a `WWW-Authenticate: Bearer`
challenge containing `resource_metadata`.

Authorization-server metadata uses [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html):
issuer `https://idp.example.com/oauth` is discovered at
`https://idp.example.com/.well-known/oauth-authorization-server/oauth`. A 404 permits the
OpenID-style discovery fallback below the issuer. The discovered issuer must match exactly.
Only its `jwks_uri` is used; the server does not guess `/.well-known/jwks.json` or trust JWT
`jku`/`x5u` headers. Discovery and keys cache for five minutes. An unknown signing key can trigger
a refresh after a five-second fetch cooldown; publish new keys before using them.

Client registration belongs to the authorization server. If it offers no dynamic registration,
use pre-registered clients or Client ID Metadata Documents where supported by both server and
host. Check the intended host's registration support before advertising compatibility. This
implementation does not add a registration proxy, login UI or consent UI.

## Token validation and scopes

Incoming access tokens must be signed EdDSA JWTs with `typ: at+jwt`, a nonempty `kid` in the
discovered key set, exact `iss`, and exactly one audience equal to the resource URI. Signature,
`exp` and any `nbf` are checked on every request. `sub` is required, the configured address claim
must contain a full fmsg address, and `scope` is a space-delimited string. Unrecognized scopes
grant no messaging capability. Tokens for another audience, including Web API/owner tokens,
are refused.

| Operations | Required scope |
|---|---|
| Identity/address lookup, inbox/sent, message/thread, delivery status, attachment download, wait, resource reads | `fmsg:read` |
| Send a new message, add recipients, react, mark read | `fmsg:write` |
| Reply (reads the parent before sending) | `fmsg:read fmsg:write` |
| Protocol initialization, tool/resource/prompt discovery and prompt templates | Valid incoming token; no messaging scope needed |

Missing scope returns `403` with `error="insufficient_scope"` and the required `scope` in the
bearer challenge. The SDK then validates tool arguments and dispatches the request. Scopes are
checked against the actual request body, including resource reads; JSON batches are refused.
The Web API still decides message visibility, recipients, account grants, quotas and acceptance.
No duplicate messaging ACLs or per-message approvals are introduced.

## Exchange, renewal and revocation

For protected operations, fmsg-mcp calls the discovered token endpoint with an
[RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html) form: token-exchange `grant_type`, incoming
`subject_token`, access-token `subject_token_type`, configured `audience`, and the granted
messaging `scope`. HTTP Basic carries the server client ID and secret. The incoming token is
never sent to the Web API, and `X-FMSG-Act-As` is never set.

The response must contain a separate JWT `access_token`, Bearer `token_type`, access-token
`issued_token_type`, positive `expires_in`, matching `scope`, and no refresh token. Its audience,
address, expiry and scopes are checked before use; the trusted token endpoint issues it, and the
Web API verifies its signature and issuer. Delegated tokens must not reach owner-only routes
such as sub-account, API-key or push administration, even outside the MCP tool surface.

Each incoming token has its own client and cache, even when two tokens name the same user.
The cache lifetime is the earliest of `expires_in`, exchanged JWT expiry, incoming JWT expiry
and five minutes from the exchange request. Renewal normally starts halfway through that lifetime.
`FMSG_MCP_KEY_CACHE_MAX` bounds retained client entries; idle OAuth entries are evicted after five
minutes. `FMSG_MCP_KEY_CACHE_TTL_SECONDS` applies only to API-key mode and cannot extend OAuth
credentials. Active requests retain their own leases through cache eviction. No token is persisted.

Web API `401` retries once after re-exchange; `403` never retries. An expiry timer closes an OAuth
WebSocket by its cached credential deadline, even if the Web API leaves it open. Waits reconnect,
catch up, and retain their original cursor, accumulated batch and timeout. Network failures use
bounded reconnect backoff with polling; cancellation closes sockets and stops exchange work.
This does not resolve the separate large-backlog/pending-thread cursor work in [ROADMAP.md](../ROADMAP.md).

- `invalid_grant` from exchange means `401`: refresh or reconnect the client connection.
- `invalid_client` / `invalid_target` means `500` plus a sanitized operator-action log. Monitor this
  log as an alert; correct the exchange configuration rather than asking users to sign in again.
- Unavailable discovery/JWKS/exchange means `503`; there is no fallback credential.
- Web API `403` with `insufficient_scope` is returned as a scope challenge. It may indicate either
  missing scope or a route permanently closed to delegated tokens; additional consent cannot open
  owner-only routes.

Authentication is checked before protected responses start. A later authentication failure also
becomes an HTTP challenge if headers have not been sent. Once a long wait has streamed progress,
HTTP cannot change its status: it finishes with an MCP authentication error and the next request
receives the appropriate challenge. Hosts should reconnect/refresh after that error, not repeat sends.

Offline validation cannot instantly detect revocation. With ten-minute incoming and five-minute
exchanged tokens, discovery operations may accept a revoked incoming token for up to ten minutes;
new Web API requests stop within five minutes once exchange starts refusing the grant. Longer
IdP lifetimes extend offline acceptance at the corresponding service. The MCP cache/socket cap
stays five minutes, but a copied upstream token remains usable directly until its actual expiry.
Configure upstream lifetimes to meet your intended revocation guarantee.

## Validation and rollout

`test/oauth.test.ts` uses a local authorization server with real Ed25519 signatures and separate
OAuth/Web API keys. It exercises discovery, invalid claims, scopes, exchange, caller isolation,
revocation, token expiry and waiting across reconnects. The fake Web API accepts registered token
fixtures; it is not a substitute for the Web API's JWT authorization tests.

Before enabling a hosted deployment, verify the deployed IdP and Web API audience configuration,
then exercise sign-in/consent, `whoami`, send/read/reply, refresh, revoked grants, scope denial and
wait cancellation through the real TLS proxy in each advertised MCP host. No live hosted-client
or deployed IdP compatibility is claimed by the local tests. API-key integration can keep running
while these services are prepared.
