# Security

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/markmnl/fmsg-mcp/security/advisories/new)
rather than a public issue.

## Scope

- Messaging authorization, grants, address status, quotas and acceptance remain the responsibility
  of fmsg-webapi and the host services. Each MCP request uses its caller's upstream identity.
- Over stdio the API key comes from the environment. HTTP callers supply their own bearer keys.
  Keys and JWTs are retained in process memory for token renewal; hashes index the HTTP client cache.
  This server does not intentionally persist them. Idle entries expire on access and periodic sweeps
  (at most 30 seconds apart); in-flight requests can retain their client until they finish. Shutdown
  clears cached clients and cancels their work. JavaScript does not guarantee memory zeroization.
- Protected upstream routes re-check grants; revoked/expired credentials remain subject to the
  upstream contract. MCP cache TTL is a retention setting, not a grant or revocation policy.
  WebSocket announcements trigger protected message reads before their content reaches the host.
  The upstream contract authenticates sockets at handshake; it does not promise immediate closure
  of existing sockets on revocation. MCP does not infer ongoing authorization from a socket alone.
- Selected key/JWT/private-key patterns are redacted from outbound message bodies, topics and errors.
  This does not detect arbitrary sensitive information or scan binary attachments.
- Message content returned to the model is labelled as data, not instructions. Hosts should still
  treat tool output as untrusted.
- Downloads return content and never write local files. Save files through the AI host's file tools
  and permissions; the tool exposes no filesystem destination argument.
- In HTTP mode terminate TLS in front of the server. `FMSG_MCP_ALLOWED_HOSTS` is required for
  non-loopback binds. Browser access validates the exact origin, including scheme and port; CORS
  preflight permission does not grant access to MCP operations.
- The upstream API must use HTTPS except loopback or an explicitly configured trusted private
  network (`FMSG_ALLOW_INSECURE_HTTP=1`). Authenticated HTTP redirects are refused.
- Tool annotations and message-data labels guide the AI host; they do not prove user approval or
  prevent prompt injection. The AI host owns tool-use permissions and authorization of automation.
  fmsg-mcp adds no separate approval gate or per-message confirmation requirement. Guidance permits
  ongoing work within the user's authorized task or automation.

When reporting, please remove API keys, tokens, addresses and message bodies from logs.
