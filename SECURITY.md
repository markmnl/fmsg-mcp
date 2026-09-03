# Security

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/markmnl/fmsg-mcp/security/advisories/new)
rather than a public issue.

## Scope

- `fmsg-mcp` never stores fmsg API keys: over stdio the key lives in the environment; over HTTP each
  request's bearer key is exchanged for a short-lived token at the configured fmsg Web API and only a
  hash of the key is kept as a cache index.
- Keys, JWTs and other secret-shaped strings are redacted from outbound message bodies, topics and
  error text before they leave the process.
- Message content returned to the model is labelled as data, not instructions. Hosts should still
  treat tool output as untrusted.
- In HTTP mode the server validates no TLS; terminate TLS in front of it and set
  `FMSG_MCP_ALLOWED_HOSTS` when binding to a non-loopback address.

When reporting, please remove API keys, tokens, addresses and message bodies from logs.
