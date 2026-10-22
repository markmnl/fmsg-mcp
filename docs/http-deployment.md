# HTTP deployment behind TLS

This example runs Caddy and fmsg-mcp on the same machine. Replace `mcp.example.com` with your DNS
name pointing to that machine; Caddy needs access to ports 80/443 for automatic public TLS.
Keep port 8765 bound to loopback. The command below uses API keys; for OAuth, or OAuth and API
keys on the same endpoint, add the [OAuth configuration](oauth.md#operator-configuration).

```sh
FMSG_API_URL=https://api.example.com \
FMSG_MCP_ALLOWED_HOSTS=mcp.example.com \
FMSG_MCP_PUBLIC_URL=https://mcp.example.com/mcp \
FMSG_MCP_ALLOWED_ORIGINS=https://mcp.example.com,https://app.example.com \
npx -y @markmnl/fmsg-mcp --http 127.0.0.1:8765
```

`FMSG_API_KEY` must be unset in HTTP mode. Include only browser origins you use.

When callers have addresses on several domains, set `FMSG_DEFAULT_DOMAIN=caller` rather than one
fixed domain: short names then resolve on each caller's own domain, so `bob` is `@bob@example.org`
for `@mark@example.org` and `@bob@example.net` for a caller on `example.net`. `whoami` and the
server instructions show that caller's domain. `FMSG_DIRECTORY` entries still take precedence.

If the server reaches the Web API at an internal address instead, for example
`FMSG_API_URL=http://10.0.0.5:8000` with `FMSG_ALLOW_INSECURE_HTTP=1` on a private network, also set
`FMSG_API_PUBLIC_URL=https://api.example.com` so `whoami` reports the URL users know. Without it,
`whoami` omits the API URL rather than show the internal address. Behind TLS,
list the public HTTPS origin explicitly: the server sees the proxy's HTTP connection and does
not trust forwarded headers to establish the request origin.

Save this as `Caddyfile`:

```caddyfile
mcp.example.com {
    @fmsg path /mcp /mcp/* /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/*
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

The metadata routes are public in `oauth` and `oauth+api-key` modes and must reach the server for
MCP authorization discovery. In API-key mode they return 404. When OAuth is configured, its resource URL supplies
the public same-origin value, so explicitly listing that origin is optional.

## Upgrades and cached tool schemas

Chat hosts may cache each tool's `outputSchema` from when the connector was added and validate
results against it. Output schemas are open and additive (see "Output schema compatibility" in the
README), so later upgrades keep validating. Schemas published by 0.2.6 and earlier were closed: after
upgrading from those releases, users whose host reports that structured content does not match the
tool's output schema must reconnect (remove and re-add) the connector once.

## Binary attachment downloads

`get_attachment_download_url` returns a resource link such as
`https://mcp.example.com/mcp/attachments/123/report.pdf`. The host fetches it with an authenticated
GET, using the same `Authorization: Bearer ...` header as its MCP connection. OAuth requires
`fmsg:read`; the server exchanges the incoming token for a Web API token as usual. The Web API
checks visibility on every download, even when a link was obtained earlier. Hosts that cannot send
the connection's Authorization header with an arbitrary GET (many chat hosts cannot) should use
`download_attachment` instead; the tool's description and result say so.

Set `FMSG_MCP_PUBLIC_URL` to the exact external MCP endpoint when using API keys. OAuth defaults
to `FMSG_MCP_OAUTH_RESOURCE_URL`; if both are set, they must match. These URLs require HTTPS outside
loopback and cannot contain credentials, queries or fragments. Request Host and forwarded headers
never select the download URL. If the proxy exposes MCP under a different public path, map that
path and everything under it to `/mcp` and `/mcp/*` respectively.

Downloads use the original MIME type, `Content-Disposition: attachment`, Unicode filename encoding,
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. The body streams with backpressure;
disconnects cancel the upstream request and incomplete transfers abort rather than complete as a
truncated file. No temporary server files, signed URLs or tokens in query strings are used.
Range/resume requests are not implemented: GET returns the full file. Treat a failed transfer as
incomplete and discard its partial local output before retrying.

## Attachment uploads

`create_draft` returns an upload URL template such as
`https://mcp.example.com/mcp/drafts/123/attachments/{filename}`. A host that can send the MCP
connection's Authorization header PUTs the raw file bytes there, then calls `send_draft`:

```sh
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "x-content-sha256: $(sha256sum report.pdf | cut -c1-64)" \
  --data-binary @report.pdf https://mcp.example.com/mcp/drafts/123/attachments/report.pdf
```

The server streams the body straight into the fmsg draft (`POST /fmsg/:id/attach`) without
storing it, so the draft and its attachments are visible in the user's other fmsg clients and the
fmsg host's own size limits apply; its refusal comes back with its status and text. OAuth requires
`fmsg:write`. The response is `201` with `filename`, `size`, `sha256` and `type`. The fmsg host may
rename a duplicate filename; the response gives the stored name. Errors are JSON `{"error": "..."}`,
and the fmsg host's own reason is passed through when it gives one.

- `x-content-sha256` (optional, hex): a mismatch answers `422`, and the attachment is removed again.
- `Content-Encoding: gzip` or `deflate` (optional): the server decodes the body while streaming, so
  fmsg stores the original file; `size` and `sha256` describe the decoded bytes. Other encodings
  answer `415`; corrupt or truncated compressed data answers `400` and nothing is kept.
- The file's type comes from `Content-Type`, except that `application/x-www-form-urlencoded`
  (curl's default for `--data-binary`) and `application/octet-stream` are replaced by the type the
  filename implies.

Uploads have no total time limit: each chunk resets a 60-second idle timeout, as for downloads.
Other requests must arrive in full within 60 seconds. Upload connections close after the response.
The server does the proxying to the fmsg host itself: a TLS proxy that forwards `/mcp/*`, like the
Caddy example above, needs no upload-specific settings. Proxies that cap request bodies by default
(nginx's `client_max_body_size` is 1 MB) should not cap them below the fmsg host's attachment limit.

### Presigned links

`get_attachment_download_url` with `presigned: true` and `get_attachment_upload_url` return links
under `/mcp/links/{token}` for hosts that cannot send the connection's Authorization header with their
own HTTP requests. Such a link carries a signed capability for one transfer:

- **GET** downloads one attachment.
- **PUT** uploads one file of the declared size and sha256 into one draft.

The link is single-use and valid for 5 minutes. It never contains the API key or an access token,
but anyone holding it can make that one transfer until it is used or expires, so hosts should treat
it as a secret. The caller a link acts for is kept in the process that issued it. Behind a load
balancer, the link therefore works only when the request reaches that instance; elsewhere the answer
is `404` with a message saying so. The proxy setup above already forwards these paths.

Host and Origin validation applies to downloads and uploads too. Allowed browser clients can preflight GET
with Authorization and read Content-Disposition. Hosts must attach the connection credential
themselves; never ask the model to locate or copy tokens. Clients that cannot fetch authenticated
links can still use `download_attachment` inline. Compatibility of authenticated links with each
third-party AI host must be tested before advertising support.
