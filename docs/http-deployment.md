# HTTP deployment behind TLS

This example runs Caddy and fmsg-mcp on the same machine. Replace `mcp.example.com` with your DNS
name pointing to that machine; Caddy needs access to ports 80/443 for automatic public TLS.
Keep port 8765 bound to loopback. Each MCP client supplies its own fmsg API key.

```sh
FMSG_API_URL=https://api.example.com \
FMSG_MCP_ALLOWED_HOSTS=mcp.example.com \
FMSG_MCP_ALLOWED_ORIGINS=https://mcp.example.com,https://app.example.com \
npx -y @markmnl/fmsg-mcp --http 127.0.0.1:8765
```

`FMSG_API_KEY` must be unset in HTTP mode. Include only browser origins you use. Behind TLS,
list the public HTTPS origin explicitly: the server sees the proxy's HTTP connection and does
not trust forwarded headers to establish the request origin.

Save this as `Caddyfile`:

```caddyfile
mcp.example.com {
    handle /mcp {
        reverse_proxy 127.0.0.1:8765 {
            transport http {
                response_header_timeout 240s
                read_timeout 240s
                write_timeout 60s
            }
        }
    }
    respond 404
}
```

Validate with `caddy validate --config Caddyfile --adapter caddyfile`, then run Caddy using your
service manager. The `/healthz` liveness endpoint remains available locally at
`http://127.0.0.1:8765/healthz`. The public MCP URL is `https://mcp.example.com/mcp`.

Caddy preserves the Host, Authorization, Origin and MCP headers. It flushes SSE responses
immediately by default. Keep the default flush setting: `flush_interval -1` disables backend
cancellation on early disconnect. Do not enable automatic retries for sending requests.
See [Caddy's streaming and proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming).

For another proxy, preserve these headers and streaming behavior, propagate disconnects, and
allow response idle time beyond `FMSG_MCP_WAIT_MAX_SECONDS` with assembly headroom. Validate
allowed and denied Host/Origin requests, unauthenticated 401 responses, CORS preflight, a read,
and cancellation through the actual deployed proxy before advertising that deployment.

This is an API-key deployment recipe. Per-user hosted OAuth onboarding is a separate workstream.
