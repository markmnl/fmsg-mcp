# Integration roadmap

Target: an MCP-capable agent can connect through a documented, tested path, identify its fmsg
account, and complete authorized messaging without exposing credentials or unexpected capabilities.
Support claims must name tested clients and versions; agents without MCP need an adapter.

## Constraints

- fmsg-webapi and host services own messaging permissions, visibility, quotas and acceptance.
  MCP binds each operation to its caller and surfaces upstream decisions.
- Normal stdio setup requires only an HTTPS API URL and key. No second login, duplicate ACLs,
  recipient policies or per-message confirmation gates. The AI host owns tool approval settings.
- Keep authorized conversations and automation convenient. Incoming messages do not authorize
  adding recipients, contacting new parties or disclosing other data.
- Remove obsolete server API fields directly while there are no external consumers requiring
  compatibility. Keep protocol compatibility needed by supported MCP hosts.

## Implementation sequence

| Work | Scope and completion criteria |
|---|---|
| A — MCP boundaries ([PR #2](https://github.com/markmnl/fmsg-mcp/pull/2)) | Separate read-only downloads from opt-in streamed saving; validate HTTP access; manage caller credentials and cancellation; preserve upstream authorization; frame untrusted content without obscuring server guidance. Regression and real-stack isolation tests cover these boundaries. |
| B — Receive reliability | Scan backlogs to a safe cursor boundary, including bursts, pending batches, interleaved threads and reconnects. Never advance past unseen work. Bound stream reads, response assembly, concurrent waits and overall deadlines. |
| C — Action outcomes | Preserve upstream denials and delivery codes. Return a durable reference and recovery guidance when a send may have committed but its response was lost; coordinate idempotency with the upstream API. |
| D — Painless local integration | Add a non-sending doctor command, separate host recipes and a versioned compatibility matrix. Verify wait defaults, attachment save/upload workflows, independent Python clients, conformance, supported OSes and clean installation of the actual npm tarball. |
| E — Hosted OAuth | Provider-neutral discovery, account linkage, consent, token refresh and revocation, coordinated with the host/account system. Prove per-user isolation in actual hosted clients. Retain explicit API-key integration. |
| F — Release trust and operations | Synchronize the existing MCP Registry listing after npm publication; verify the published version. Harden release inputs and gates, reusing D's artifact checks. Add deployment metrics, runbooks, load testing and independent review when supporting shared hosted service. |

Ship A first, then B–D. Plan E with the host/account-system maintainer. Release work in F can proceed
earlier; hosted-service promises depend on verified OAuth and operational behavior.

Release-triggered npm publication, OIDC trusted publishing, provenance generation and version
synchronization already exist in [publish.yml](.github/workflows/publish.yml). Preserve them.
[CI](https://github.com/markmnl/fmsg-mcp/actions/workflows/tests.yml) already covers Node 22/24,
the Docker image and real two-host acceptance. PR checks record validation for each revision.

## Broad-integration release criteria

- Fresh installs on every claimed client/OS reach `whoami` and inbox using the documented setup.
- Caller isolation and upstream authorization hold across tools, resources, attachments and waits.
- Backlog/reconnect tests prove no silent cursor loss; cancellation releases work promptly.
- Tool deadlines and payload budgets fit verified host configurations; large files are practical
  without manual base64 handling or overflowing model context.
- Ambiguous sends have a documented reconciliation path that avoids blind duplicate sends.
- Advertised hosted integrations pass identity, refresh, revocation and disconnect checks.
- The npm artifact, registry metadata, release notes and compatibility results agree.
