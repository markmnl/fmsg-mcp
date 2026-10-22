# File-uploads extension: implementation notes

fmsg-mcp implements the MCP file-uploads extension (`io.modelcontextprotocol/files`). It follows the
draft in [modelcontextprotocol/experimental-ext-file-uploads](https://github.com/modelcontextprotocol/experimental-ext-file-uploads),
`specification/draft/file-uploads.md` on branch `localden/initial-draft` at commit
`6101d34eb52b21d4b87028543ecd1fd59ed3d5df` (2026-10-21). That is the head of the draft branch after
PR #2 merged as `348c794`, plus two later commits: gateway relays and the proposed download shape.

These notes are feedback for the File Uploads Working Group. They list each place where the draft was
ambiguous or silent, what this server chose, and a suggested change to the draft. Section names refer
to the draft.

## What is implemented

- **Negotiation.** `server/discover` advertises `{"io.modelcontextprotocol/files": {"maxInlineBytes": N}}`.
  It does so only over Streamable HTTP when the public MCP URL is `https`, because only then can the
  server issue usable targets.
- **File arguments.** The `attachments` items of `send_message`, `reply` and `create_draft` take
  `anyOf: [classic attachment, FileInput]`. The FileInput branch is marked with `x-mcp-file`, and a
  call may carry several files.
- **Inline files.** The data is decoded and its size and digest are checked before anything is created.
- **Out-of-band files.** Every check that needs no bytes runs first. Then the call's fmsg draft is
  created as the staging location, inline files are attached, and the call answers `input_required`
  with one target per file under `inputRequests.uploads`.
- **Targets.** `PUT {public MCP URL}/uploads/{token}` with `credentials: "include"`. The token is an
  HMAC over the principal, draft, file id, attachment name, declared size, SHA-256, media type, call id
  and expiry. A target takes one successful upload and refuses other sizes and digests. It is
  same-origin https and short-lived (10 minutes by default). Bytes stream into the draft; nothing is
  stored on the MCP server.
- **Retry.** `requestState` is verified, and must match the tool, the canonical argument hash and the
  outcomes. Each file is confirmed in the draft by name, size and SHA-256. Then the tool runs: the
  draft is sent, or returned for `create_draft`.
- **Unchanged without the extension.** `data_base64`, `data_text` and stdio `path` work as before for
  clients that don't use the extension.
- **Tests.** `test/files-extension.test.ts` runs a minimal client harness over HTTPS through a TLS
  proxy (`test/files-client.ts`). The harness implements the client side: per-request declaration,
  target checks, PUT with at most three attempts, and the retry.

Downloads are not implemented: the section is marked as not yet reviewed by the working group.

## Ambiguities and gaps

### 1. The SDK has no MRTR extension point (Open Question 1)

**Gap.** The TypeScript SDK (v2.0.0) refuses an `inputRequests` entry whose method is not elicitation,
sampling or roots. It throws before the result leaves the server. The draft names this gap.

**Choice.** The tool returns `input_required` with only `requestState`, which the SDK accepts. The HTTP
layer then adds `inputRequests.uploads` to that one JSON-RPC response, in JSON and SSE bodies alike. A
per-request `AsyncLocalStorage` scope carries the offer from the tool to the response. On the way in,
the SDK passes `inputResponses.uploads` through untouched, because its "bare response" filter only
drops entries with `method` or `result` keys.

**Suggested fix.** Let MRTR carry extension-defined input requests: allow method names under a
declared extension's namespace, gated on the request's declared extensions. Say that the bare-response
rule applies to their answers too. SDKs then need a registration hook instead of a closed union.

### 2. The shape of the upload answer is not defined

**Gap.** The draft gives a JSON example for `inputResponses.uploads` with
`{"resultType": "complete", "files": [...]}`, but no TypeScript interface. MRTR's other embedded
responses are bare results without `resultType`, so it is unclear whether `resultType` is required or
what other values it may take.

**Choice.** `resultType: "complete"` is required. `files` must be an array of `{fileId, status}`, with
`status` either `completed` or `failed`.

**Suggested fix.** Add the missing interface, for example
`interface UploadInputResponse { resultType: "complete"; files: { fileId: string; status: "completed" | "failed" }[] }`.
Either say why it carries `resultType` when other MRTR responses don't, or drop the field.

### 3. A marked schema inside `anyOf`, and what hosts hide

**Gap.** The draft says `x-mcp-file` goes on "an object schema in `Tool.inputSchema`, including array
items". This server needs one argument to take either a classic attachment or a FileInput. The draft
does not say whether a marked schema may be one branch of `anyOf`/`oneOf`. Hosts "SHOULD NOT show
`x-mcp-file` properties" to a model, and it is unclear whether that means the marked branch or the
whole property. Hiding the whole property would also take away the classic path models use.

**Choice.** The marked FileInput schema is one branch of the items' `anyOf`. The other branch is the
classic attachment.

**Suggested fix.** Allow marked schemas as `anyOf`/`oneOf` branches. Tell hosts to remove only the
marked branch from what the model sees.

### 4. Do inline FileInputs need the extension declared?

**Gap.** "Clients MUST NOT use this extension with a server that did not advertise it", and servers
MAY answer `-32021` for oversized inline data on an undeclared request. The draft does not say whether
an inline FileInput (one with `data`) needs a per-request declaration, or what a server answers to a
data-less FileInput from a request that did not declare the extension.

**Choice.** Inline FileInputs are accepted from any request, because they are ordinary arguments that
match the schema. A data-less FileInput from an undeclared request gets a tool error saying no target
can be issued and how to send the file instead. It does not get `-32021`, because a model reading the
error can act on it.

**Suggested fix.** State that inline transfer needs no declaration. Specify the error for a data-less
FileInput on an undeclared request.

### 5. What `maxInlineBytes` counts

**Gap.** It is "the largest total decoded size of inline `data` values the server accepts in one
request". This server also has base64 arguments outside FileInputs, and the draft does not say
whether those count.

**Choice.** Only `FileInput.data` counts. The default is 1 MiB, configurable with
`FMSG_MCP_FILES_MAX_INLINE_BYTES`.

**Suggested fix.** Say it applies only to FileInput `data`.

### 6. How a retry is rejected

**Gap.** Retry step 1 says to return `-32602` when `requestState` verification fails. Steps 2 and 3
say "rejects the call" and "rejects duplicate or unknown file IDs and unknown statuses" without saying
how. In the SDK, an exception from a tool handler becomes a `CallToolResult` with `isError: true`, so
`-32602` is only practical at the state-verification seam.

**Choice.** `-32602` (`Invalid or expired requestState`) is used when the state's MAC, expiry or
principal binding fails. A different tool, different arguments, or malformed, duplicate or unknown
outcomes get a tool error that names the problem. These don't run the tool or consume the call, so the
correct retry still works.

**Suggested fix.** Give the error form for each step. Tool errors fit steps 2 and 3, and SEP-1303
already treats input problems as tool errors.

### 7. Missing outcomes: "follow MRTR error handling"

**Gap.** MRTR does not define what to do with a retry that leaves some requested input unanswered.

**Choice.** The server asks again: it returns `input_required` with the same targets and a freshly
signed `requestState` for the same call. The call's identity is the server's call id, not the state
string, so the old and new state strings both lead to one execution.

**Suggested fix.** Say that the server SHOULD re-issue the outstanding targets, and that this is not a
new round (rule: "A replacement target requires a new state").

### 8. Early retries

**Gap.** Step 4 says servers MUST NOT run the tool with bytes they have not confirmed, but not what
they return.

**Choice.** A tool error that names the files whose bytes have not arrived. The call and its targets
stay valid, so the client can PUT and retry with the same `requestState` before the targets expire.

**Suggested fix.** Specify the answer. Either a tool error that leaves the round open, or re-issuing
the targets for the missing files.

### 9. Repeated continuations

**Gap.** "MUST NOT execute a call twice on a repeated continuation" does not say what a repeat gets
back, or how this works across server instances.

**Choice.** A tool error naming what already happened ("already completed (message 123 was sent)").
Concurrent retries are serialised per call, so one runs and the other is told it is in progress.
Across instances, the draft itself is the record: a sent draft is not sent again.

**Suggested fix.** Say whether a repeat should replay the original result, which is friendlier to
clients that lost the response but needs stored results, or return an error. Note that enforcement
across instances needs shared state or a backend record.

### 10. Expired targets versus expired state

**Gap.** The draft does not separate target expiry from `requestState` expiry. When the state
expires, the SDK answers with a frozen `-32602 "Invalid or expired requestState"` that cannot say what
happened.

**Choice.** `requestState` outlives its targets by an hour. A PUT to an expired target gets `410`.
A retry after expiry gets a tool error saying the targets expired at a stated time and to call the
tool again, and the staging draft is discarded.

**Suggested fix.** Recommend that state outlive targets, and specify the error for a retry after
target expiry and the status for a PUT to an expired target.

### 11. What "single-use" means, given three attempts per file

**Gap.** The Transfer section allows three HTTP attempts per file, and the draft speaks of a file's
"outstanding target". If a target were burned by any request, a failed attempt would leave nothing to
retry.

**Choice.** A target accepts one *successful* upload. Attempts that store nothing, such as a short
body, a size or digest mismatch, or a dropped connection, leave it usable. A second upload after a
success, or one while another upload is in progress, gets `409`.

**Suggested fix.** Define single-use as "accepts one successful upload", and give the status for
reuse.

### 12. Which target failures are permanent

**Gap.** Clients must "stop sooner if a failure is permanent", but the draft does not say which
statuses are permanent, so the three-attempt rule is not interoperable.

**Choice.** The target answers `413` (more bytes than declared, or Content-Length too large), `400`
(fewer bytes), `422` (digest mismatch), `409` (used, in progress, or call finished), `410` (expired),
`401` (no credential), `403` (another principal or missing scope) and `404` (unknown target). The
harness retries only network errors, `408`, `429` and `5xx`.

**Suggested fix.** List the retryable statuses (`408`, `429`, `5xx`, network errors) and treat other
`4xx` as permanent.

### 13. Content-Encoding on uploads

**Gap.** The Downloads section says `size` and `digest` describe bytes after `Content-Encoding` is
removed. The upload sections don't say this, and "MUST NOT send more bytes than the declared size"
does not say whether encoded or decoded bytes count.

**Choice.** Targets accept `gzip` and `deflate`, and enforce size and digest on the decoded bytes.
When the body is encoded, the Content-Length check is skipped.

**Suggested fix.** Use the download rule for uploads too, and say the byte limit is on decoded bytes.

### 14. Which media type wins

**Gap.** A target's `headers` may include `Content-Type`, but the draft does not say whether the
server trusts the PUT's header or the declared `mimeType`.

**Choice.** The `mimeType` bound into the target is what is stored. The PUT's `Content-Type` is
ignored.

**Suggested fix.** Say the declared `mimeType` is authoritative and the header is advisory.

### 15. Canonical URI for non-OAuth deployments

**Gap.** `credentials: "include"` depends on the server's canonical URI, which the authorization
specification defines for OAuth. This server also accepts static API-key bearers, and the draft does
not define the canonical URI there.

**Choice.** Targets live under the configured public MCP URL, which is the OAuth resource URL when
OAuth is configured. So `{public URL}/uploads/...` passes the origin-and-path rule.

**Suggested fix.** Define the canonical URI for non-OAuth bearers as the URL the client connects to.

### 16. `include` or `omit`

**Not a gap; recorded for the "Authorization methods" question.** This server issues `include`
targets. The bytes travel with the credential the client already presents to the MCP server, and the
URL is not a secret: anyone who sees it still needs that credential. The server holds no credential
for later use: it resolves the caller from the PUT's own bearer, as for any request. The cost is that
browser clients send a CORS preflight for the `Authorization` header, which the server answers for its
allowed origins. Gateways that
hold credentials would relay the PUT, as the Transfer section allows.

### 17. Staging and finalize when the backend has no expiry (Open Question 4)

**Gap.** "Servers SHOULD rely on storage-side expiry to reclaim uploads with no retry." fmsg drafts do
not expire, and they are visible in the user's other clients. A target needs a destination before
bytes arrive, so the draft exists from the initial call. "Finalize" is sending the draft.

**Choice.** With a per-process key, only this process can complete the call, so a call whose targets
expire without a retry has its unsent draft deleted a minute after expiry. With a shared key
(`FMSG_MCP_STATE_SECRET`, for several instances), another instance may have completed the call.
`create_draft`'s result is itself an unsent draft, so nothing is deleted automatically, and an
abandoned call can leave a draft behind.

**Suggested fix.** Acknowledge backends without storage-side expiry. Either recommend that servers not
create user-visible artifacts before the retry, or add a way for clients to cancel an abandoned call.

### 18. Checks that need information the backend doesn't expose

**Gap.** Servers "SHOULD run every check that does not need the bytes", including quota. The fmsg Web
API has no limits or quota endpoint. It enforces attachment size when the bytes arrive and the sender's
quota when the message is sent.

**Choice.** The initial call checks recipients, the parent's reply rules, ids, names, media type,
digest form, the operator's per-file limit (`FMSG_MCP_FILES_MAX_FILE_BYTES`, advertised as `maxSize`)
and the inline budget. Host limits refused later are returned verbatim: at the PUT (for example `413`)
or in the retry's tool error.

**Suggested fix.** Say that failures found after the bytes arrive are reported in the retry's
`CallToolResult`, and that the metadata checks are best effort.

### 19. Names

**Gap.** `FileInput.name` is optional and unconstrained. The draft lists "name collisions" as a
metadata check, but does not say whether that means the client's names or the names the server
stores. fmsg attachment names allow only letters, digits, `.`, `_` and `-`.

**Choice.** Other characters become `_`, so `Q3 report.pdf` is stored as `Q3_report.pdf`. A missing
name becomes `file-N`. Collisions are checked case-insensitively on the stored names, including
classic attachments in the same call. The result lists the stored names.

**Suggested fix.** Say servers may normalise names, must report the stored name, and that collisions
apply to stored names.

### 20. Bounds on `id`

**Gap.** `FileInput.id` has no length or character limits.

**Choice.** 1 to 128 characters.

**Suggested fix.** Give a bound.

### 21. "Exact arguments": raw or parsed

**Gap.** Servers bind "all arguments" and reject a retry whose arguments differ. The draft does not
say whether the comparison is on the raw JSON or on the arguments after schema validation (defaults
filled in, unknown keys stripped).

**Choice.** A SHA-256 of the canonical JSON (sorted keys) of the validated arguments.

**Suggested fix.** Specify the comparison, or at least say "equal after the server's input
validation".

### 22. `requestState` is readable by the client

**Gap.** The SDK's codec signs `requestState` but does not encrypt it, and the client echoes it. A
server that bound a self-authorizing (`omit`) URL into the state would hand it back in every retry,
although clients "MUST NOT include upload URLs or credentials in the response".

**Choice.** The state holds file ids, names, sizes, digests, the draft id and the call id, and no
target URLs. Targets are signed separately.

**Suggested fix.** Say servers must not put self-authorizing target URLs in unencrypted state.

### 23. Advertising when only inline transfer is possible

**Gap.** "A server that accepts out-of-band uploads advertises the extension." Over stdio this server
has no HTTPS endpoint for targets, and the draft does not say whether a server that can only take
inline FileInputs should advertise.

**Choice.** No advertisement and no FileInput schema over stdio. Large files there use the existing
upload-folder `path` argument instead.

**Suggested fix.** Say whether advertising implies the server can issue targets on that transport,
or add a way to advertise inline-only support.

### 24. Type re-check after upload

**Gap.** Servers "re-check size, digest and type once the bytes arrive". The draft does not say what
re-checking type means: content sniffing, or enforcing the declared type.

**Choice.** Size and digest are enforced. The declared `mimeType` is what the file is stored and
served as. There is no content sniffing, because fmsg carries any media type.

**Suggested fix.** Say what "type" re-checking requires.

## Configuration (this server)

| Variable | Default | Meaning |
|---|---|---|
| `FMSG_MCP_FILES_EXTENSION` | `on` | `off` stops advertising the extension and accepting FileInputs. |
| `FMSG_MCP_FILES_MAX_INLINE_BYTES` | `1048576` | Advertised `maxInlineBytes`. |
| `FMSG_MCP_FILES_MAX_FILE_BYTES` | unset | Per-file limit, advertised as `x-mcp-file.maxSize`. |
| `FMSG_MCP_FILES_TARGET_TTL_SECONDS` | `600` | Target lifetime. |
| `FMSG_MCP_STATE_SECRET` | per-process random | HMAC key of at least 32 bytes, so several instances can serve one call. |
