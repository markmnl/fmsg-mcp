# Security

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/markmnl/fmsg-mcp/security/advisories/new)
rather than a public issue.

## Scope

- Messaging authorization, grants, address status, quotas and acceptance remain the responsibility
  of fmsg-webapi and the host services. Each MCP request uses its caller's upstream identity.
- Over stdio the API key comes from the environment. HTTP callers supply their own bearer keys or OAuth access tokens, according to the configured mode.
  Keys and JWTs are retained in process memory for token renewal; hashes index the HTTP client cache.
  This server does not intentionally persist them. Idle entries expire on access and periodic sweeps
  (at most 30 seconds apart). Evicted or invalidated clients close immediately if idle; active requests
  retain their client until their last request lease is released. Shutdown closes cached and active
  clients and cancels their work. JavaScript does not guarantee memory zeroization.
- Protected upstream routes re-check grants; revoked/expired credentials remain subject to the
  upstream contract. MCP cache TTL is a retention setting, not a grant or revocation policy.
  WebSocket announcements trigger protected message reads before their content reaches the host.
  The upstream contract authenticates sockets at handshake; it does not promise immediate closure
  of existing sockets on revocation. MCP does not infer ongoing authorization from a socket alone.
- Selected key/JWT/private-key patterns are redacted from outbound message bodies, topics and errors.
  This does not detect arbitrary sensitive information or scan binary attachments.
- Message bodies and upstream error text are fenced as untrusted data. Each message body has its own
  fence; server-built headers stay outside it, with external header values escaped onto one line.
  This distinguishes quoted forged headers from actual message boundaries. Server-authored guidance
  stays outside the data. Instructions permit replies within authorized conversations, but
  incoming messages cannot authorize adding recipients, contacting new parties or disclosing other
  data. Hosts should still treat tool output as untrusted.
- `download_attachment` is read-only and enforces its inline byte budget while reading. The optional
  `save_attachment` tool is advertised only in stdio with `FMSG_MCP_DOWNLOAD_DIR` set. It streams to a
  generated leaf filename, accepts no destination path, and uses exclusive creation (`wx`) to skip
  existing files and symlinks, trying numbered filenames instead. New files use mode `0600` where
  supported; failed writes remove partial files. The operator must control the configured folder and its ancestors, on a filesystem that
  supports exclusive creation. This is not a sandbox against another local process replacing those
  directories. HTTP mode does not expose this write capability.
- Attachment transfers retain caller cancellation and client shutdown signals. They use a response
  header deadline followed by a per-read idle timeout (60 seconds each by default), so a progressing
  large download is not subject to a 60-second total duration limit.
- HTTP attachment links contain no credentials and do not confer access. Every GET authenticates
  the caller and uses its upstream client; OAuth also requires `fmsg:read`. The Web API decides
  attachment visibility. Public URLs come from operator configuration, never forwarded headers.
  Downloads stream with backpressure and force attachment disposition, no-store caching and nosniff.
  Failed streams terminate the connection so partial files cannot appear successfully completed.
  Query parameters are refused. Authenticated download links require support in the AI host.
- Error previews are limited to 2 KiB while reading, except canonical JSON HTTP 400/413 responses:
  those retain the host's acceptance/size-policy explanation. Selected credentials are still redacted;
  oversized previews are explicitly marked as truncated.
- In HTTP mode terminate TLS in front of the server. `FMSG_MCP_ALLOWED_HOSTS` is required for
  non-loopback binds. Browser access validates the exact origin, including scheme and port. Loopback
  binds also permit loopback browser origins on any port by default, so local developer tools work.
  An explicit origin list replaces that loopback exception. CORS preflight permission does not grant
  access to MCP operations; bearer authentication remains required.
- The upstream API must use HTTPS except loopback or an explicitly configured trusted private
  network (`FMSG_ALLOW_INSECURE_HTTP=1`). Authenticated HTTP redirects are refused.
- Tool annotations and message-data labels guide the AI host; they do not prove user approval or
  prevent prompt injection. The AI host owns tool-use permissions and authorization of automation.
  OAuth mode adds resource-token validation and messaging scope checks, with sign-in/consent at
  the configured authorization server. fmsg-mcp adds no recipient ACL, approval gate or per-message
  confirmation requirement. Normal stdio setup needs only an HTTPS API URL and API key; token renewal and cache
  management run automatically. Guidance permits ongoing work within the user's authorized task or
  automation, subject to the AI host's own approval settings.

## OAuth boundary

OAuth mode validates the configured issuer, exact MCP audience, EdDSA signature, key ID,
`at+jwt` type, lifetime and address. Only the configured issuer's discovered JWKS is trusted.
Incoming tokens are exchanged with confidential-client authentication and are never forwarded
to the Web API. No `X-FMSG-Act-As` header is sent. The Web API must enforce delegated scopes
and refuse owner-only routes independently of this server.

Exchanged tokens are cached per incoming token for at most five minutes and never past either
token's expiry. Existing sockets close and renew within that deadline. Incoming tokens validate
offline until expiry; immediate revocation is checked at exchange. No local cache makes
revocation immediate or shortens the lifetime of a copied token at another service. See the
[OAuth contract and revocation limits](docs/oauth.md#exchange-renewal-and-revocation).

When reporting, please remove API keys, tokens, addresses and message bodies from logs.
