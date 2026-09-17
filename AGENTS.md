# fmsg-mcp

TypeScript MCP server that gives any MCP host an fmsg address, talking directly to a
deployed [fmsg Web API](https://github.com/markmnl/fmsg-webapi) (FMSG-003). Published to npm
as `@markmnl/fmsg-mcp`; runnable with `npx -y @markmnl/fmsg-mcp`.

## API contract

The canonical contract is the fmsg-webapi README and
[FMSG-003](https://github.com/markmnl/fmsg/blob/main/standards/fmsg-003-webapi.md). The client in
`src/client/` is written against it directly. Key facts:

- `POST /fmsg/token` exchanges an `fmsgk_…` API key for a short-lived JWT whose `sub` is the address.
  The client also accepts a caller-bound `TokenProvider` (see `docs/token-providers.md`). It renews
  5 minutes before expiry, capped at half the acquired lifetime, and retries once on 401.
- `id`/`pid` are int64 JSON numbers. They are decimal **strings** everywhere in this codebase; only
  `src/client/message-id.ts` converts at the JSON boundary (reviver with `context.source`).
- Sending is draft → attach → send; the draft is deleted if a later step fails.
- Size and acceptance limits are host configuration. Never hard-code or pre-warn about them; surface
  the host's 400/413 text and per-recipient delivery codes verbatim.
- A message with `reaction != null` *is* a reaction (hidden from lists). `terminal` messages reject
  replies, add-to and reactions (409). `no_reply` messages are never auto-replied.

## Layout

```
src/index.ts        bin entry: stdio by default, --http [host:port], --version, --help
src/config.ts       env → Config; FMSG_API_KEY required for stdio and refused for HTTP
src/server.ts       createFmsgMcpServer(provider, config): registration only, no I/O
src/context.ts      CallerProvider: fixed caller over stdio, per-bearer-credential over HTTP
src/auth.ts         HTTP bearer verifier: key hash → cached FmsgClient + address
src/oauth/          HTTP OAuth discovery, validation, scopes and token exchange
src/http.ts         node:http server, /mcp + /healthz, Host/Origin allowlist, bearer gate
src/tools/*.ts      one file per tool group; src/tools/common.ts has shared schemas/helpers
src/wait.ts         wait_for_message engine (WebSocket first, inbox catch-up, settle batching)
src/thread.ts       thread assembly via /thread/messages with a pid-walk fallback
src/render.ts       Markdown rendering for content[0].text; truncation; injection preamble
src/client/         exported fmsg-webapi client (`@markmnl/fmsg-mcp/client`)
test/fake-fmsg-server.ts   in-memory fmsg-webapi with WebSocket push, used by all unit tests
test/fmsg-docker.e2e.test.ts   real two-host run, gated by FMSG_E2E=1
```

## Conventions

- ESM, Node ≥ 22, MCP SDK v2 (`@modelcontextprotocol/server`), `import * as z from "zod/v4"`.
- Every tool returns concise Markdown in `content[0].text` **and** `structuredContent` matching its
  `outputSchema`. Failures are `isError: true` results built by `src/errors.ts`, never thrown past
  the handler.
- Irreversible send-type tools carry `destructiveHint: true`; reversible reactions use
  `destructiveHint: false` and `idempotentHint: true`. Read tools use `readOnlyHint: true`.
- Outbound bodies/topics and every error string pass through `redactSecrets`. Never log an API key;
  log the address and a key-hash prefix.
- Use `src/render.ts` for untrusted message content: a preamble, escaped single-line header values,
  and a separate fence per body. Server-authored guidance stays outside the data.
- stdout is the stdio protocol channel: log with `console.error` only.
- Public OSS repo: never name a specific identity provider; use `example.com` in examples.

OAuth mode validates incoming tokens for the exact MCP audience and exchanges them for a
separate Web API token. Never forward the incoming JWT or send `X-FMSG-Act-As`. Keep scope
classification in `src/oauth/scopes.ts` synchronized with tools; reply needs read and write.
See `docs/oauth.md` for the vendor-neutral claims contract and deployment requirements.

## Adding a tool

1. Register it in the matching `src/tools/*.ts` (or a new file wired in `src/server.ts`) with
   `title`, `description` written for the model, a zod `inputSchema`, an `outputSchema`, and
   annotations. Use `withCaller(deps, ctx, …)` to resolve the client and map errors.
2. Extend `test/fake-fmsg-server.ts` if a new route is needed, add a test in `test/tools.test.ts`,
   and update the tools table in `README.md` in the same change.

## Commands

```sh
npm ci
npm run typecheck && npm run build && npm test      # unit tests (build first: stdio test spawns dist/)
npx @modelcontextprotocol/inspector node dist/index.js
bash .github/scripts/run-fmsg-docker-e2e.sh         # real stacks via fmsg-docker (needs Docker + Go)
```

## Releasing

Tag `vX.Y.Z`, publish a GitHub release; `.github/workflows/publish.yml` sets the version from the
tag, runs the checks and publishes to npm with OIDC trusted publishing. After npm succeeds, a
separate job publishes the matching `server.json` to the MCP Registry using GitHub OIDC; no
registry secret is required. Drafts and prereleases do not publish. If only the registry job
fails, re-run failed jobs to retry it without republishing npm.
