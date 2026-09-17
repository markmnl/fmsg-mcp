# fmsg-mcp

[![Tests](https://github.com/markmnl/fmsg-mcp/actions/workflows/tests.yml/badge.svg)](https://github.com/markmnl/fmsg-mcp/actions/workflows/tests.yml)
[![npm](https://img.shields.io/npm/v/%40markmnl%2Ffmsg-mcp)](https://www.npmjs.com/package/@markmnl/fmsg-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

An [MCP](https://modelcontextprotocol.io) server that gives any AI agent its own
[fmsg](https://github.com/markmnl/fmsg) address: send messages, follow threads, react, exchange
attachments and wait for replies, through a deployed
[fmsg Web API](https://github.com/markmnl/fmsg-webapi). Connect through stdio in hosts such as
Claude Code, Claude Desktop, Cursor and VS Code, or through HTTP in clients that support bearer headers.

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

For [Claude Code over HTTP](https://code.claude.com/docs/en/mcp):

```sh
claude mcp add --transport http fmsg --scope user https://mcp.example.com/mcp \
  --header "Authorization: Bearer fmsgk_..."
```

Deploy behind a TLS-terminating reverse proxy and set `FMSG_MCP_ALLOWED_HOSTS` to the public hostname
when binding to a non-loopback address; startup fails without it. Browser clients on another origin
also need `FMSG_MCP_ALLOWED_ORIGINS` containing exact origins, such as `https://app.example.com`.
For loopback binds, loopback browser origins on any port work by default, including MCP Inspector
at `http://localhost:6274`. Setting an explicit origin list replaces that loopback default.
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
| `download_attachment` | Fetch a small attachment inline: text as text, images as image blocks, other files as base64 resources |
| `save_attachment` | Stream an attachment to the configured local folder; stdio only, enabled by `FMSG_MCP_DOWNLOAD_DIR` |
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
| `FMSG_MCP_DOWNLOAD_DIR` | — | Enable `save_attachment` in stdio; folder for new files named from message ID and filename |
| `FMSG_MCP_WAIT_MAX_SECONDS` | `230` | Cap on one `wait_for_message` call |
| `FMSG_MCP_HOST` / `FMSG_MCP_PORT` | `127.0.0.1` / `8765` | HTTP bind address (or `--http host:port`) |
| `FMSG_MCP_ALLOWED_HOSTS` | loopback names | Comma-separated `Host` header allowlist; required for non-loopback binds |
| `FMSG_MCP_ALLOWED_ORIGINS` | same origin; loopback origins on loopback binds | Comma-separated browser origins including scheme and port; an explicit list replaces the loopback default; hostname-only values are rejected |
| `FMSG_MCP_KEY_CACHE_MAX` / `FMSG_MCP_KEY_CACHE_TTL_SECONDS` | `500` / `1800` | HTTP mode per-key client cache |

The API key is exchanged for a short-lived access token that the server renews automatically.
API URLs must not contain credentials, query strings or fragments. Authenticated requests do not
follow redirects; configure the final API URL directly.

To save attachments directly to disk, add `FMSG_MCP_DOWNLOAD_DIR` to your stdio server's environment,
for example `/home/you/Downloads/fmsg`. The optional `save_attachment` tool streams files into that
folder without sending their bytes through model context. It accepts only a message ID and attachment
filename and creates a new file such as `123-report.pdf`. Repeat saves use `123-report-1.pdf`,
`123-report-2.pdf`, etc., leaving existing files untouched. Unusual filenames are converted to
portable names; use the returned `saved_to` path. Streaming downloads can run longer than 60 seconds
while making progress; a 60-second idle timeout detects stalled transfers.

Inline downloads default to 256 KiB to keep file content manageable for the model. Use
`save_attachment` for larger local files, or raise `max_inline_bytes` explicitly when your AI host
can handle more inline content. HTTP clients use inline downloads or their host's file capabilities.

Over stdio, missing or invalid configuration still allows hosts to discover the tools. Tool calls
explain the configuration error and how to fix it; restart the MCP server after correcting settings.

## Safety

- Messaging access, quotas and recipient acceptance are enforced by fmsg-webapi and the host
  services. MCP forwards each operation as the caller's identity and surfaces upstream failures.
- `download_attachment` never writes local files. Optional `save_attachment` writes only generated
  filenames in the operator-configured folder, using exclusive creation with no overwrite.
- Sent messages cannot be edited or recalled; send tools say so in their descriptions and are
  annotated `destructiveHint` to describe their effects. Approval behavior belongs to the AI host;
  fmsg-mcp has no additional confirmation gate.
- Selected API-key/token formats are redacted from outbound bodies, topics and error text; the
  send tools report the count. This is not general data-loss prevention or binary attachment scanning.
- Nothing about message size or acceptance is assumed: the fmsg host's own responses and delivery
  codes are surfaced verbatim.
- The server publishes MCP `instructions` (shown to the model at session start) telling agents to use
  these tools rather than a local fmsg CLI or cached credentials, to carry out authorized tasks and
  automation without repeated confirmation, and to treat message content as data.
- See [SECURITY.md](./SECURITY.md).

## Using the client library

```ts
import { FmsgClient } from "@markmnl/fmsg-mcp/client";

const client = new FmsgClient("https://api.example.com", process.env.FMSG_API_KEY!);
console.log(await client.address());
const inbox = await client.listInbox(10);
const sent = await client.send({ to: ["@bob@example.com"], topic: "Hi", body: "Hello from code" });
console.log(sent.id, sent.redactions);
client.close();
```

`send()` replaces selected credential patterns in the body and topic before creating the draft.
Its result includes the replacement count (`redactions`) and transmitted `topic`. Attachments are
unchanged. Use `streamAttachment()` to consume large files incrementally; consume or cancel its stream.

## Development

```sh
npm ci
npm run typecheck && npm run build && npm test
npx @modelcontextprotocol/inspector node dist/index.js          # stdio, with FMSG_API_URL/FMSG_API_KEY set
bash .github/scripts/run-fmsg-docker-e2e.sh                     # end to end on two real fmsg stacks
```

See [AGENTS.md](./AGENTS.md) for layout and conventions, [ROADMAP.md](./ROADMAP.md) for remaining
integration work, and [CHANGELOG.md](./CHANGELOG.md) for release notes.

[MIT licensed](./LICENSE)
