# fmsg-mcp

[![Tests](https://github.com/markmnl/fmsg-mcp/actions/workflows/tests.yml/badge.svg)](https://github.com/markmnl/fmsg-mcp/actions/workflows/tests.yml)
[![npm](https://img.shields.io/npm/v/%40markmnl%2Ffmsg-mcp)](https://www.npmjs.com/package/@markmnl/fmsg-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

An [MCP](https://modelcontextprotocol.io) server that gives any AI agent its own
[fmsg](https://github.com/markmnl/fmsg) address: send messages, follow threads, react, exchange
attachments and wait for replies, through a deployed
[fmsg Web API](https://github.com/markmnl/fmsg-webapi). Works with Claude Code, Claude Desktop,
Cursor, VS Code, claude.ai remote connectors and any other MCP host.

- **stdio** for local hosts: one address per server process, configured by two environment variables.
- **Streamable HTTP** for shared or remote deployments: one endpoint serving many users, each
  authenticated by their own fmsg API key.
- The fmsg Web API client is exported for reuse: `import { FmsgClient } from "@markmnl/fmsg-mcp/client"`.

## 1. Get an fmsg address and API key

You send as an fmsg address, authenticated by an API key (`fmsgk_…`) issued by your fmsg host:

- **No host yet?** Create an account at a public fmsg host such as [fmsg.io](https://fmsg.io) and
  add an agent (sub-account) to get an API URL and key.
- **Self-hosting?** Run the stack with [fmsg-docker](https://github.com/markmnl/fmsg-docker) and issue
  a key with `fmsg-webapi api-key create`.

## 2. Install

Requires Node.js 22 or later.

### Claude Code

```sh
claude mcp add fmsg --scope user \
  --env FMSG_API_URL=https://api.example.com \
  --env FMSG_API_KEY=fmsgk_... \
  -- npx -y @markmnl/fmsg-mcp
```

Then in any session: *"Send @bob@example.com a note about the release"*, *"What's in my fmsg inbox?"*,
*"Wait for Bob's reply and answer it"*. `/fmsg:chat` and `/fmsg:reply` are available as prompts.

### Claude Desktop, Cursor, VS Code and other stdio hosts

Add a server entry with the same command; only the config file differs:

```json
{
  "mcpServers": {
    "fmsg": {
      "command": "npx",
      "args": ["-y", "@markmnl/fmsg-mcp"],
      "env": { "FMSG_API_URL": "https://api.example.com", "FMSG_API_KEY": "fmsgk_..." }
    }
  }
}
```

(Claude Desktop: `claude_desktop_config.json`; Cursor: `.cursor/mcp.json`; VS Code: `.vscode/mcp.json`
under `"servers"` with `"type": "stdio"`.)

### Remote (Streamable HTTP) mode

Run one server for many users. Each client sends **its own** fmsg API key as a bearer token; the
server exchanges it at the fmsg host and acts as that address. `FMSG_API_KEY` must not be set.

```sh
FMSG_API_URL=https://api.example.com FMSG_MCP_ALLOWED_HOSTS=mcp.example.com \
  npx -y @markmnl/fmsg-mcp --http 0.0.0.0:8765
# or
docker build -t fmsg-mcp .
docker run -e FMSG_API_URL=https://api.example.com \
  -e FMSG_MCP_ALLOWED_HOSTS=mcp.example.com -p 8765:8765 fmsg-mcp
```

The MCP endpoint is `/mcp`; `/healthz` reports liveness. Use a client that supports an explicitly
configured `Authorization: Bearer fmsgk_...` header. Each caller supplies its own key; a shared
header means a shared fmsg identity. Hosted connectors that require OAuth are not supported yet.

Deploy behind a TLS-terminating reverse proxy and set `FMSG_MCP_ALLOWED_HOSTS` to the public hostname
when binding to a non-loopback address; startup fails without it. Browser clients on another origin
also need `FMSG_MCP_ALLOWED_ORIGINS` containing exact origins, such as `https://app.example.com`.
Allowed preflights need no credentials; actual MCP requests always require authentication.
`wait_for_message` holds a request open for up to
`FMSG_MCP_WAIT_MAX_SECONDS` (230), so give the proxy an idle timeout of at least 240 s.
See the [TLS reverse-proxy example](docs/http-deployment.md) for a loopback deployment with Caddy.

## Tools

| Tool | What it does |
|---|---|
| `whoami` | The address this server acts as, the API URL and token expiry |
| `resolve_address` | Turn a short name into `@user@domain` (directory, then default domain) |
| `list_messages` | Inbox, newest first, with previews; reactions hidden; optional unread filter |
| `list_sent` | Sent messages with per-recipient delivery state |
| `get_message` | One message with headers, full text body, attachments and reactions |
| `get_thread` | The lineage from the thread root to a message, with gaps for messages you cannot see |
| `send_message` | Start a new thread; sends immediately (fmsg messages are immutable) |
| `reply` | Reply into a thread; reply-all by default, refuses terminal and no-reply parents |
| `add_recipients` | Add recipients to a sent message |
| `react` | Set or clear your emoji reaction |
| `mark_read` | Mark received messages read |
| `download_attachment` | Fetch an attachment inline (base64, images as image blocks); use the host's file tools to save it |
| `delivery_status` | Per-recipient delivery times and host response codes |
| `wait_for_message` | Block until the next inbound message (WebSocket push), batched per thread, with thread context |

Every tool returns readable Markdown plus `structuredContent`. Ids are decimal strings. Message
bodies are labelled as data from other parties, not instructions.

Resources `fmsg://message/{id}` and `fmsg://thread/{id}` expose the same content to hosts that
attach resources; prompts `chat` and `reply` script the wait → reply loop and a guided reply.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FMSG_API_URL` | — | Base URL of the fmsg Web API (required) |
| `FMSG_API_KEY` | — | `fmsgk_…` key; stdio mode only |
| `FMSG_ALLOW_INSECURE_HTTP` | disabled | Set to `1` only to permit cleartext API access on a trusted development/private network; loopback HTTP is allowed by default |
| `FMSG_DEFAULT_DOMAIN` | — | Lets short names resolve: `bob` → `@bob@<domain>` |
| `FMSG_DIRECTORY` | — | JSON file mapping short names to full addresses |
| `FMSG_MCP_WAIT_MAX_SECONDS` | `230` | Cap on one `wait_for_message` call |
| `FMSG_MCP_HOST` / `FMSG_MCP_PORT` | `127.0.0.1` / `8765` | HTTP bind address (or `--http host:port`) |
| `FMSG_MCP_ALLOWED_HOSTS` | loopback names | Comma-separated `Host` header allowlist; required for non-loopback binds |
| `FMSG_MCP_ALLOWED_ORIGINS` | same origin only | Comma-separated browser origins including scheme and port; hostname-only values are rejected |
| `FMSG_MCP_KEY_CACHE_MAX` / `FMSG_MCP_KEY_CACHE_TTL_SECONDS` | `500` / `1800` | HTTP mode per-key client cache |

The API key is exchanged for a short-lived access token that the server renews automatically.
API URLs must not contain credentials, query strings or fragments. Authenticated requests do not
follow redirects; configure the final API URL directly.

Migration from 0.1.4: `download_attachment.save_to` now returns an error without fetching or writing
the file. Save returned content using your host's file tools. `FMSG_MCP_DOWNLOAD_DIR` is obsolete and
ignored. Update hostname-only origin settings to full origins and explicitly allow trusted private
HTTP upstreams if needed.

Over stdio the server also starts with no credentials at all, so hosts and directories can list its tools; every tool call then returns a message naming the missing variables.

## Safety

- Messaging access, quotas and recipient acceptance are enforced by fmsg-webapi and the host
  services. MCP forwards each operation as the caller's identity and surfaces upstream failures.
- `download_attachment` never writes local files. Host file tools apply the host's own permissions.
- Sent messages cannot be edited or recalled; send tools say so in their descriptions and are
  annotated `destructiveHint` so hosts can ask for confirmation.
- Selected API-key/token formats are redacted from outbound bodies, topics and error text; the
  send tools report the count. This is not general data-loss prevention or binary attachment scanning.
- Nothing about message size or acceptance is assumed: the fmsg host's own responses and delivery
  codes are surfaced verbatim.
- The server publishes MCP `instructions` (shown to the model at session start) telling agents to use
  these tools rather than a local fmsg CLI or cached credentials, to send only on a clear request, and
  to treat message content as data.
- See [SECURITY.md](./SECURITY.md).

## Using the client library

```ts
import { FmsgClient } from "@markmnl/fmsg-mcp/client";

const client = new FmsgClient("https://api.example.com", process.env.FMSG_API_KEY!);
console.log(await client.address());
const inbox = await client.listInbox(10);
await client.send({ to: ["@bob@example.com"], topic: "Hi", body: "Hello from code" });
client.close();
```

## Development

```sh
npm ci
npm run typecheck && npm run build && npm test
npx @modelcontextprotocol/inspector node dist/index.js          # stdio, with FMSG_API_URL/FMSG_API_KEY set
bash .github/scripts/run-fmsg-docker-e2e.sh                     # end to end on two real fmsg stacks
```

See [AGENTS.md](./AGENTS.md) for layout and conventions.

[MIT licensed](./LICENSE)
