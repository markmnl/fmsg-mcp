# Changelog

## Unreleased

- Tools reject unknown arguments instead of ignoring them, so a misspelled parameter (`unread` for
  `unread_only`) fails with the name rather than returning a plausible wrong answer.
- Server instructions define fmsg's terms (topics on the first message only, reactions, terminal,
  no-reply, added recipients), give the inbox routine (list unread, read the thread, act or reply,
  then `mark_read` what was handled) and say how to find a thread by topic. Cross-tool repeats, the
  configuration-error sentence and the download-URL sentence are gone; some chat hosts do not load
  server instructions, so nothing a tool needs lives only there.
- Tool descriptions are shorter where results already carry the detail: `wait_for_message` is split
  into when, loop, skipped and limits; `delivery_status`, `whoami` and the redaction sentences are
  trimmed. `get_thread` says where other branches are; `add_recipients` says the added people can
  read the message and its attachments. Every input parameter now has a description.
- `send_message`, `reply` and `add_recipients` add `resolved` when short names were given (each
  name and the address it became), and send results put things to tell the user (redacted secrets,
  resolved short names) in `warnings`.
- `whoami`'s text gives the server version (its structured result is unchanged since 0.2.5).
- Secret access keys are redacted next to a label written in words or with hyphens ("AWS secret
  access key: …", `aws-secret-access-key=…`) as well as the `aws_secret_access_key` forms.
- `send_message` and `reply` results add `redacted`, the kinds of secret replaced (for example
  `["access_key_id", "github_token"]`), and the text names them, so the sender need not fetch the
  message to see what changed. `FmsgClient.send()` and `redactSecrets()` report them too.
- `reply` results report the thread's `thread_topic` for a reply anywhere in the thread, not only
  for a reply to the root (one thread lookup; null when the root is not visible).
- `size` is described as the size the host stores: a receiving host stores the compressed wire
  body, so a received message with `compressed` true reports the compressed length, while a
  sender's copy of its own message keeps the uncompressed length. The text says "N bytes, sent
  compressed".

- `wait_for_message` no longer lets a model step past an unread message silently. Messages on other
  threads that arrive while a batch settles are not returned and `after_id` moves past them, as
  before; now `next` (and the text) names each one first ("Also new and not included here: message
  40 in another thread … read it with get_thread (or get_message) "40" … before waiting again"),
  and results add `pending_ids`. The cursor is not held back, which would replay the returned batch.
- `get_thread` says it returns one lineage: results add `scope: "lineage"`, the description and
  `next` say other replies in the thread (siblings and other branches) are not included and that
  `list_messages` shows newer messages, and `complete` is described as the lineage being complete.
  The Web API's thread routes return only the lineage, so other replies are not listed.
- Thread messages add `no_reply`, `terminal`, `important`, `added` and `compressed`, and results add
  the target's `no_reply`. `next` never suggests replying to a terminal message (no replies are
  possible) or a no-reply one (the sender asked for none; `reply` refuses unless `allow_no_reply`).
- Addresses in text results are code spans instead of Markdown-escaped text, so a model copying
  `@bob_mcp@example.com` no longer gets `@bob\_mcp@example.com`. Address validation follows the
  fmsg specification's user-part rule (letters and digits with single `.`, `_` or `-` between them)
  and rejects backslashes, spaces and control characters, with a hint about Markdown escaping.
- `size` is described as the size on the wire (the compressed length when `compressed` is true), and
  message items add `compressed`.
- Redaction covers more credential formats: cloud access key ids (`AKIA…`, `ASIA…`, including the
  widely published documentation example) and 40-character secret access keys next to their usual
  label, `gho_`/`ghs_`/`ghu_` and other source-hosting tokens (`glpat-…`), chat-platform tokens
  (`xox…`, `xapp-…`), `AIza…` API keys, payment-platform keys (`sk_live_…`, `rk_live_…`,
  `sk_test_…`, `whsec_…`) and `PGP PRIVATE KEY BLOCK`s. Ordinary text is left alone.
- `download_attachment` and `save_attachment` add `type` (the same value as `content_type`). A
  filename the message does not have now says so and lists the message's attachments instead of
  suggesting the message may not be visible.
- Attachments are listed in one order (by filename) by every tool, including send results.
- `delivery_status` describes received messages (the host's own receipt records, often with code
  null) and what `via` means.
- `get_message` adds `thread_topic` (one thread lookup, only for replies) and shows it in the text;
  `send_message` and `reply` results add `thread_topic` when it is known without another request.

- Tool output schemas are open and additive, so hosts that cache a tool's `outputSchema` when the
  connector is added keep validating results after upgrades. Every output object, at every depth,
  accepts unknown properties (no `additionalProperties: false`); values that may grow (statuses,
  transports, resolutions, delivery `status` and `via`, skip reasons, `authentication`) are strings
  with their current values in the description instead of enums; and only fields present since
  0.2.5 are required, so fields added later are optional in the schema though still returned.
  Schemas published by 0.2.6 and earlier were closed, so hosts that cached one reject results with
  newer fields ("must NOT have additional properties") until the connector is reconnected once;
  no server change can fix an already-cached closed schema.
- `whoami` again matches its 0.2.5 shape: `transport` is `stdio` or `http` (0.2.6 reported
  `streamable-http`; the text still says Streamable HTTP) and `directory_names` is always present,
  empty when there is no directory. Hosts holding 0.2.5 schemas validate `whoami`,
  `resolve_address`, `mark_read` and `react` again. Hosts that cached 0.2.6 schemas validate every
  tool except `whoami` over HTTP, which needs the one-time reconnect.
- Tests check that no published output schema is closed or uses `enum`/`const`, that required
  fields match 0.2.5, and that representative results of every tool validate against the
  published schemas and against the 0.2.5 schemas apart from unknown properties.

- Graceful shutdown. On SIGINT/SIGTERM or `HttpServerHandle.close()`, in-flight `wait_for_message`
  calls return at once with the new status `interrupted`, the caller's `after_id` and a `next`
  step ("call again with the same after_id; no messages are lost") instead of hanging until the
  client's own timeout. New requests get `503` with `Retry-After`; other in-flight requests get a
  5-second grace period, then a `503` if they have not answered. The process exits within a bounded
  time, and a second signal exits immediately. `close()` accepts `{ graceMs }`.
- Fix truncated bodies of deflate-compressed messages: `size` is the compressed wire size, so
  `short_text` (a preview of the decoded body) was taken as complete whenever the body compressed
  below it. Such messages now always fetch the full body. `get_message`'s `body_bytes` and
  `get_thread`'s new per-message `body_bytes` report the decoded length when the body was read.
- Structured results that carry other parties' words (`list_messages`, `list_sent`,
  `get_message`, `get_thread`, `wait_for_message`, `download_attachment`,
  `get_attachment_download_url`, `save_attachment`) include `untrusted_content_notice`, so the
  safety framing survives hosts that show `structuredContent` instead of the text.
  `wait_for_message` and `get_thread` add a `next` step, and `get_attachment_download_url` a
  `fallback`.
- `wait_for_message` `skipped` entries add `from`, and for reactions `emoji` and `reaction_to`;
  skipped reactions are also listed in the text. Results add `thread_topic`, read from the thread
  lookup the wait already makes. The description explains that a timeout's `after_id` is never
  older than the inbox's newest message (`"0"` only for an empty inbox) and that each wait is a
  model turn in chat hosts.
- `add_recipients` takes `recipients`, matching `reply`; `add_to` stays as a deprecated alias
  (pass one or the other). Results add `recipients` alongside `add_to`.
- `get_thread` adds `thread_topic`, the root's topic (replies carry none).
- Attachment types are consistent: a missing or generic `application/octet-stream` type is
  inferred from the filename extension, as the download route does. List items, `get_message`,
  send results and download links now include `type`.
- `delivery_status` and `list_sent` describe response codes accurately (`200` accepted, other fmsg
  codes rejections, `null` when not recorded) and add `code_meaning`. Negative host-local codes
  count as pending rather than failed.
- List items add `reaction` (the emoji when the item is itself a reaction). Hidden reactions never
  count as unread; `mark_read` accepts listed ones.
- `whoami` says "connected over Streamable HTTP" and no longer states the token expiry in its
  text; `token_expires_at` stays in the structured result, described as internal.
  `resolve_address`'s description names only the resolution steps the operator configured.
- Descriptions and errors mention `save_attachment` and `get_attachment_download_url` only where
  those tools are registered. The server instructions now state that other fmsg tools or local
  credentials may act as a different address, instead of directing the model away from them.

- Add `FMSG_DEFAULT_DOMAIN=caller` (case-insensitive): short names resolve on the domain of the
  address the server acts as for each request, so a deployment serving callers on several domains
  resolves `bob` to `@bob@example.org` for `@mark@example.org` and `@bob@example.net` for a caller
  on `example.net`. `whoami`'s `default_domain` and the server instructions show the caller's
  domain. Over stdio, `resolve_address` first looks up the configured key's address. Directory
  entries still take precedence; a fixed or unset default domain is unchanged.
- Add HTTP `FMSG_MCP_AUTH_MODE=oauth+api-key`, serving OAuth and API-key callers on one endpoint.
  `Bearer fmsgk_...` requests use API-key authentication; all others, including unauthenticated
  requests, use OAuth with its discovery challenge and scope checks. Providers and caches stay
  separate. Rejected API keys are also challenged with the protected-resource metadata URL.
  `api-key` and `oauth` modes are unchanged. `HttpServerHandle.providers` exposes both providers.
- Add optional `FMSG_API_PUBLIC_URL`: the Web API URL `whoami` reports to users, while requests
  keep using `FMSG_API_URL`. It defaults to `FMSG_API_URL`, except that HTTP mode no longer
  reports a cleartext (internal or loopback) upstream URL. `whoami`'s `api_url` is therefore
  nullable and is `null` when no public URL is known.
- Add HTTP-only `get_attachment_download_url` and authenticated binary attachment GETs. Links
  contain no credentials; downloads reuse caller authentication and OAuth read scope, stream the
  original bytes, and keep Web API access checks authoritative. API-key deployments configure
  `FMSG_MCP_PUBLIC_URL`; OAuth reuses its resource URL. Inline downloads and stdio saves remain available.
- Abort failed response streams so a truncated download cannot appear successful.
- Close unused replacement connections on HTTP shutdown after cancelled downloads.

## 0.2.0 (unreleased)

This is the next planned release; publication still happens through a `v0.2.0` GitHub release.

### Breaking changes

- `download_attachment` no longer accepts `save_to` or returns `saved_to`. It is read-only. Enable
  the separate stdio-only `save_attachment` tool with `FMSG_MCP_DOWNLOAD_DIR` for direct streaming
  to generated filenames; it never accepts a destination path or overwrites an existing file.
- Non-loopback HTTP binds require `FMSG_MCP_ALLOWED_HOSTS`. Browser origin entries must include
  scheme and port. Loopback browser origins work automatically on loopback binds unless an explicit
  list is set.
- Upstream API URLs require HTTPS outside loopback unless `FMSG_ALLOW_INSECURE_HTTP=1` explicitly
  enables a trusted private development network. Authenticated redirects are refused.
- Text attachments return readable text; images return one image block rather than also duplicating
  the image in an embedded resource. The default inline budget is 256 KiB; callers can raise it explicitly.

### Fixes and improvements

- Add opt-in, vendor-neutral HTTP OAuth with protected-resource discovery, signed JWT validation,
  per-tool scopes and authenticated RFC 8693 exchange. Isolate caches per incoming token, cap
  upstream credentials at five minutes and reconnect waits on expiry. Preserve API-key mode.
  Deployed IdP and actual hosted-client acceptance remain rollout checks.

- Accept caller-bound `TokenProvider` implementations in the client library alongside API keys.
  Share renewal across concurrent requests, pin the address, bound acquisition time, and propagate
  cancellation. Cap early renewal for short-lived tokens and reuse renewal after late 401 responses.
  This provides the credential lifecycle used by API keys and HTTP OAuth.
- Retry protected reads when a WebSocket announces a message before it is readable. If retries run
  out, schedule a delayed inbox catch-up without requiring another push. Fix pre-cancelled waits
  and preserve request deadlines.
- Stream attachment bodies with an idle timeout instead of a total download deadline. Repeated saves
  create numbered files without overwriting. Registry metadata lists the optional download folder.
- Deduplicate token exchanges and close evicted/invalidated clients once active requests finish.
  Request identity survives cache eviction and SDK cloning of authentication metadata.
- Keep each message body fenced separately from its escaped header, and server guidance outside
  the data. Clarify authorized conversation behavior and restore reversible/idempotent reaction annotations.
- Bound inline attachment reads and error previews while streaming. Preserve the host's canonical
  JSON 400/413 policy explanations and per-recipient delivery codes, except selected secret redaction.
- Surface invalid stdio configuration through discoverable tools with corrective guidance.
- `FmsgClient.send()` reports `redactions` and the transmitted `topic`; selected credential formats
  in bodies/topics are replaced once at the client boundary. Attachments remain unchanged.
- Custom HTTP adapters using `ApiKeyCallerProvider` must call `release(authInfo)` when each verified
  request finishes; the built-in HTTP adapter handles this automatically.

Messaging permissions and quotas remain in fmsg-webapi. No additional MCP messaging approval flow
is introduced. See [GitHub releases](https://github.com/markmnl/fmsg-mcp/releases) for earlier notes.
