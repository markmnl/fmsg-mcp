# File-uploads extension: implementation notes

fmsg-mcp implements the MCP file-uploads extension (`io.modelcontextprotocol/files`). It follows
`specification/draft/file-uploads.md` in
[modelcontextprotocol/experimental-ext-file-uploads](https://github.com/modelcontextprotocol/experimental-ext-file-uploads)
as merged in PR #1, at commit `0b61430f3cba684493e05759e34b14ee5ef24822` (2026-11-07). An earlier
version of this server followed the draft at `6101d34`; [What changed](#what-changed-from-the-6101d34-draft)
lists how that draft's gaps were settled.

These notes are feedback for the File Uploads Working Group. They describe what this server does, the
choices it makes where the spec is open, and suggested changes. Section names refer to the spec.

## What is implemented

- **Negotiation.** Over Streamable HTTP, `server/discover` advertises
  `{"io.modelcontextprotocol/files": {"upload": {}, "maxInlineBytes": N}}`. `maxInlineBytes` is left out
  when it is configured as `0`. Requests declare the extension in their per-request client capabilities;
  a settings object with a `revision` this server does not know counts as no declaration.
- **File arguments.** The `attachments` items of `send_message`, `reply` and `create_draft` take
  `anyOf: [classic attachment, FileInput]`. The FileInput branch carries `x-mcp-file` (with `maxSize`
  when an operator limit is set) and requires `id`, `mimeType` and `size`. `tools/list` shows the
  FileInput branch only to requests that declare the extension (Backward Compatibility); `tools/call`
  always accepts it, since inline files need no declaration.
- **Inline files.** The data is decoded, and its size, the inline budget and the digest (when given) are
  checked before anything is created. A file of `size` 0, with no `data` or an empty string, is an empty
  attachment and never gets a target.
- **Out-of-band files.** Every check that needs no bytes runs first. A non-empty file without `data` on
  a request that did not declare `upload` gets `-32021`. Otherwise the call's fmsg draft is created as the
  staging location, inline files are attached, and the call answers `upload_required` with one target
  per such file.
- **Targets.** `{"path": "/uploads/{token}", "method": "PUT", "headers": {"Content-Type": mimeType},
  "credentials": "include", "expiresAt": ...}`. The token is an HMAC over the principal, draft, file id,
  attachment name, declared size, digest (when given), media type, call id and start deadline. A target
  takes one successful upload, refuses other sizes and digests, and accepts uploads started within 10
  minutes by default. Bytes stream into the draft; nothing is stored on the MCP server.
- **Retry.** The SDK verifies `requestState` (MAC, expiry, principal binding). The server then checks the
  tool name and an argument hash, and that the call has not run; a mismatch or reuse gets `-32602`. Each
  file is confirmed in the draft by name and size, and by SHA-256 when a digest was declared. A file that
  has not arrived ends the call with a tool error and deletes the draft. Then the tool runs: the draft is
  sent, or returned for `create_draft`.
- **Unchanged without the extension.** `data_base64`, `data_text`, `files` (ChatGPT's file references)
  and stdio `path` work as before.
- **Tests.** `test/files-extension.test.ts` runs a client harness over HTTPS through a TLS proxy
  (`test/files-client.ts`). The harness implements the client side: per-request declaration, the Targets
  checks, `path` resolution, PUT with a bounded repeat, no retry after a failed transfer, and the retry.

Downloads are not implemented yet: the spec marks that section as not reviewed. The existing
presigned download links (`get_attachment_download_url`) already have the shape of a `url` target with
`credentials: "omit"`.

## Choices and open points

### 1. The SDK cannot return the extension's results from a tool

**Gap.** McpServer validates a tool's return value as a `CallToolResult` unless it is `input_required`,
and turns anything a tool throws into a tool error. So a tool can return neither `upload_required` nor
the JSON-RPC errors the spec requires (`-32021`, and `-32602` for argument mismatches and reuse, which
the SDK's `requestState` hook cannot detect because it does not see the arguments).

**Choice.** The tool returns `input_required` carrying a marker in `requestState`, and the HTTP layer
puts the upload request or the error in its place, in JSON and SSE bodies alike. A JSON response with
`-32021` gets HTTP 400, as the SDK does for its own `-32021`. On an SSE response the status is already
sent, so it stays 200.

**Suggested fix.** In the SDKs: let a tool return an extension result type when the request declared
that extension, and let it throw a `ProtocolError` that reaches the wire. Give the `requestState` verify
hook the request's params, so argument binding can fail with `-32602` there.

### 2. Staging in a backend without storage-side expiry (Staging; Open Question 5)

**Gap.** A target needs a destination before bytes arrive, so the draft exists from the initial call.
fmsg drafts do not expire, and they are visible in the user's other clients as drafts (not as sent
messages, so nothing is "exposed as finished"). The server learns of a failed transfer only when no
retry arrives.

**Choice.** With a per-process key only this process can complete the call, so an unsent draft is
deleted once its `requestState` expires (target lifetime plus 15 minutes). With a shared key
(`FMSG_MCP_STATE_SECRET`, for several instances), another instance may have completed the call, and
`create_draft`'s result is itself an unsent draft, so nothing is deleted automatically.

**Suggested fix.** Open Question 5's failure signal would let the server delete the draft at once.
Mention backends whose staging is user-visible.

### 3. At most once across instances (Repeated Retries)

**Gap.** For tools unsafe to run twice, the spec requires consuming `requestState` atomically "in
storage every instance shares". This server has no shared store of its own.

**Choice.** In one process, a call record is claimed before the tool runs, and a reused state gets
`-32602`. Across instances, the draft is the shared record: the fmsg host sends a draft once, so a
second retry finds it sent (`-32602`) or fails to send it. `create_draft` is safe to run twice.

**Suggested fix.** Allow a backend's own once-only operation to serve as the shared record.

### 4. Argument equality

**Choice.** The arguments are compared as the tool's schema parsed them, by a SHA-256 of their
canonical JSON (sorted keys). Member order and number spelling do not matter, as the spec requires.
Defaults are filled in before the comparison, so a retry that spells out a default still matches.

### 5. Content-Encoding on uploads

**Gap.** The Downloads section says `size` and `digest` describe the bytes after `Content-Encoding` is
removed. The upload sections do not say this, and "MUST NOT send more file bytes than the declared
`size`" does not say whether encoded or decoded bytes count.

**Choice.** Targets accept `gzip` and `deflate`, and enforce size and digest on the decoded bytes. When
the body is encoded, the `Content-Length` check is skipped.

**Suggested fix.** Use the download rule for uploads too.

### 6. Target statuses

**Gap.** Clients "MAY repeat a failed `PUT` ... up to a bound", but the spec does not say which
failures are worth repeating.

**Choice.** A target answers `413` (more bytes than declared), `400` (fewer bytes), `422` (digest
mismatch), `409` (used, in progress, or call finished), `410` (started after `expiresAt`), `401` (no
credential), `403` (another principal or missing scope) and `404` (unknown target). Only a successful
upload uses a target up. The harness repeats only network errors, `408`, `429` and `5xx`.

**Suggested fix.** List the statuses worth repeating, and treat other `4xx` as final.

### 7. Names

**Gap.** `FileInput.name` is free text; fmsg attachment names allow only letters, digits, `.`, `_` and
`-`. The spec defines a base name for multipart `filename`, but not what a server stores.

**Choice.** The base name (after `/` and `\`) is kept, and other characters become `_`, so
`reports/Q3 report.pdf` is stored as `Q3_report.pdf`. A missing name becomes `file-N`. Collisions are
checked case-insensitively on the stored names, including classic attachments in the same call, and the
result lists the stored names.

**Suggested fix.** Say servers may normalise names and must report the stored name.

### 8. Quota and other checks the backend does not expose

**Choice.** The initial call checks recipients, the parent's reply rules, ids, names, media type, digest
form, the operator's per-file limit (`maxSize`) and the inline budget. The fmsg Web API has no quota
endpoint: host limits refused later are returned verbatim, at the PUT (for example `413`) or in the
retry's tool error.

### 9. stdio

**Choice.** Over stdio the server neither advertises the extension nor lists FileInputs. It has no
HTTPS endpoint for `url` targets, which is all the spec allows on stdio. Large files there use the
upload-folder `path` argument. Inline-only support (advertising `maxInlineBytes` without `upload`) would
be possible later.

## What changed from the 6101d34 draft

The 24 points in the earlier version of these notes were settled as follows.

| Earlier point | In the merged spec | This server now |
|---|---|---|
| No MRTR extension point; upload answer shape | Own result type `upload_required`; the retry carries only `requestState` | Answers `upload_required` (see point 1) |
| `x-mcp-file` inside `anyOf`; what hosts hide | Allowed in `anyOf`/`oneOf`; hosts hide that branch only | Unchanged |
| Inline files without a declaration | Allowed; servers must not reject them | Unchanged |
| What `maxInlineBytes` counts | Inline `data` of file arguments; `0` or absent means no inline | Omits it when `0` |
| How a retry is rejected | Errors table: `-32602` for state, tool, arguments, principal | `-32602` for all of these |
| Missing outcomes; early retries | No outcomes; bytes not arrived is `isError`, tool not run | Ends the call, deletes the draft |
| Repeated continuations | At most once for unsafe tools, consumed atomically | See point 3 |
| Target expiry vs state expiry | `expiresAt` is a start deadline; state covers a late transfer and the retry | State outlives targets by 15 minutes |
| Single-use with repeats | Repeat a failed PUT up to a bound; targets accept one write | One successful upload |
| Which media type wins | Client sends `Content-Type` exactly as `headers` lists it | Declared `mimeType` stored |
| Canonical URI without OAuth | The MCP address | `path` targets avoid the question |
| Undeclared out-of-band file | `-32021` | `-32021` (was a tool error) |
| Digest always required | Optional; checked when the tool requires it | Optional; checked when given |
| Type re-check | Inspect bytes only if the tool restricts type | No restriction, no inspection |

## Configuration (this server)

| Variable | Default | Meaning |
|---|---|---|
| `FMSG_MCP_FILES_EXTENSION` | `on` (HTTP) | `off` stops advertising the extension and accepting FileInputs. |
| `FMSG_MCP_FILES_MAX_INLINE_BYTES` | `1048576` | Advertised `maxInlineBytes`; `0` accepts no inline files. |
| `FMSG_MCP_FILES_MAX_FILE_BYTES` | unset | Per-file limit, advertised as `x-mcp-file.maxSize`. |
| `FMSG_MCP_FILES_TARGET_TTL_SECONDS` | `600` | How long targets accept a new upload. |
| `FMSG_MCP_STATE_SECRET` | per-process random | HMAC key of at least 32 bytes, so several instances can serve one call. |
