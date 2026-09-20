# HTTP deployment behind TLS

This example runs Caddy and fmsg-mcp on the same machine. Replace `mcp.example.com` with your DNS
name pointing to that machine; Caddy needs access to ports 80/443 for automatic public TLS.
Keep port 8765 bound to loopback. The command below uses API keys; for OAuth add the
[OAuth configuration](oauth.md#operator-configuration).

```sh
FMSG_API_URL=https://api.example.com \
FMSG_MCP_ALLOWED_HOSTS=mcp.example.com \
FMSG_MCP_PUBLIC_URL=https://mcp.example.com/mcp \
FMSG_MCP_ALLOWED_ORIGINS=https://mcp.example.com,https://app.example.com \
npx -y @markmnl/fmsg-mcp --http 127.0.0.1:8765
```

`FMSG_API_KEY` must be unset in HTTP mode. Include only browser origins you use. Behind TLS,
list the public HTTPS origin explicitly: the server sees the proxy's HTTP connection and does
not trust forwarded headers to establish the request origin.

Save this as `Caddyfile`:

```caddyfile
mcp.example.com {
    @fmsg path /mcp /mcp/attachments/* /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/*
    handle @fmsg {
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

The metadata routes are public in OAuth mode and must reach the server for MCP authorization
discovery. In API-key mode they return 404. When OAuth is configured, its resource URL supplies
the public same-origin value, so explicitly listing that origin is optional.

## Binary attachment downloads

`get_attachment_download_url` returns a resource link such as
`https://mcp.example.com/mcp/attachments/123/report.pdf`. The host fetches it with an authenticated
GET, using the same `Authorization: Bearer ...` header as its MCP connection. OAuth requires
`fmsg:read`; the server exchanges the incoming token for a Web API token as usual. The Web API
checks visibility on every download, even when a link was obtained earlier.

Set `FMSG_MCP_PUBLIC_URL` to the exact external MCP endpoint when using API keys. OAuth defaults
to `FMSG_MCP_OAUTH_RESOURCE_URL`; if both are set, they must match. These URLs require HTTPS outside
loopback and cannot contain credentials, queries or fragments. Request Host and forwarded headers
never select the download URL. If the proxy exposes MCP under a different public path, map that
path and its `/attachments/*` suffix to `/mcp` and `/mcp/attachments/*` respectively.

Downloads use the original MIME type, `Content-Disposition: attachment`, Unicode filename encoding,
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. The body streams with backpressure;
disconnects cancel the upstream request and incomplete transfers abort rather than complete as a
truncated file. No temporary server files, signed URLs or tokens in query strings are used.
Range/resume requests are not implemented: GET returns the full file. Treat a failed transfer as
incomplete and discard its partial local output before retrying.

Host and Origin validation applies to downloads too. Allowed browser clients can preflight GET
with Authorization and read Content-Disposition. Hosts must attach the connection credential
themselves; never ask the model to locate or copy tokens. Clients that cannot fetch authenticated
links can still use `download_attachment` inline. Compatibility of authenticated links with each
third-party AI host must be tested before advertising support.
