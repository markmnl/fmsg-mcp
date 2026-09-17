# Changelog

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

- Accept caller-bound `TokenProvider` implementations in the client library alongside API keys.
  Share renewal across concurrent requests, pin the address, bound acquisition time, and propagate
  cancellation. Cap early renewal for short-lived tokens and reuse renewal after late 401 responses.
  This is the OAuth foundation; hosted OAuth remains separate integration work.
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
