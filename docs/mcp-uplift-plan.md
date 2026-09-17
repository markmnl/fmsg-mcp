**fmsg-mcp integration, safety, and trust uplift plan**

Reviewed 2026-09-17 against version 0.1.4, commit `329b803`. Implementation is proceeding on `feature/mcp-integration-uplift`; status is recorded below.

**Implementation status — 2026-09-17**

Work package A is implemented locally as the first safety change:

- Attachment downloads never write files. The portable confinement fallback in this plan was selected: delegate saving to the AI host's file tools. Legacy `save_to` calls return a migration error; `FMSG_MCP_DOWNLOAD_DIR` is ignored.
- Non-loopback HTTP binds require allowed hosts. Origin checks use exact scheme/host/port, permitted browser preflight does not require a key, and actual requests still require each caller's own key. The upstream URL requires HTTPS outside loopback unless explicitly opted into a trusted private HTTP network; authenticated redirects and malformed download paths are refused. A [TLS proxy recipe](http-deployment.md) documents the boundary.
- Credential exchange is deduplicated per key, idle cache entries expire before reuse and on periodic sweeps, and request identity survives cache eviction. Shutdown releases cached credentials; security documentation describes in-memory retention accurately. fmsg-webapi remains authoritative for messaging permissions and quotas.
- Headers, previews, bodies, attachments, resources and partial errors are framed as untrusted data; tool/resource/HTTP logs and host errors use centralized secret redaction. Host error status, code and text survive the MCP boundary, except selected secret patterns. Irreversible-send guidance comes first; reaction annotations follow the external-send convention.
- Already-cancelled waits fail before upstream work; request deadlines remain enabled with caller signals. HTTP cancellation closes wait sockets. WebSocket events cause a fresh protected message read, so an existing socket cannot authorize content after upstream revocation.

Validation: typecheck, build and 59 local tests pass, including cross-caller tools/resources, revoked-key/socket behavior, CORS, redirects, file-write refusal, host-error preservation and cancellation. Real-stack isolation cases were added to the Docker acceptance suite; they are **not run locally because Docker is unavailable**. The proxy recipe was checked against Caddy documentation, but no live TLS proxy or AI-host prompt-injection evaluation was run here.

Next is work package B. The known backlog/pending cursor defects, broader deadline/stream budgets and default wait duration are still outstanding; this first change does not establish the broad-integration definition of done. Hosted OAuth, compatibility certification and MCP Registry publication remain later workstreams. Existing npm publication and provenance are preserved.

The target is: **an MCP-capable agent can connect through a documented, tested path, identify its fmsg account, and perform authorized messaging reliably without exposing credentials or granting unexpected capabilities.** Publish the tested compatibility envelope. An agent without an MCP client needs an adapter; no server can guarantee support for every proprietary host, policy, or future version.

The foundation is worth retaining: stdio and Streamable HTTP, a small production dependency set, per-key callers, exact int64 message IDs, structured successes plus readable text, resources and prompts, draft cleanup, WebSocket/poll fallback, MIT licensing, security reporting instructions, a non-root container, and OIDC-oriented npm publishing. CI already includes Node 22/24 and real two-host acceptance testing.

**Evidence from this review**

`npm run typecheck`, `npm run build`, and all 38 unit tests passed on Node 24.18.0. `npm audit --omit=dev --json` reported zero known production dependency vulnerabilities at review time. A follow-up release check confirmed the successful v0.1.4 publish workflow, the npm 0.1.4 package, its published provenance statement, and an existing MCP Registry listing whose latest version remains 0.1.0. The statement names the expected repository, workflow, tag, and commit; a full cryptographic verification of its signature/transparency chain was not run. The real Docker acceptance suite, actual host applications, production deployments, and repository protection settings were not verified. Passing tests and a clean dependency audit do not establish application security.

Three disposable local probes exercised the built code with synthetic clients/data. Temporary files were removed; no real messages were sent:

| Finding | Evidence | Priority |
|---|---|---|
| A tool marked read-only can overwrite files outside its configured download directory | `download_attachment(save_to=...)` followed a symlink under the allowed directory and replaced an existing file outside it. Result: success; advertised `readOnlyHint: true`. See [read tools](../src/tools/read.ts). | P0 |
| Inbox catch-up can permanently skip unseen messages | With IDs 1–200 queued and `after_id=0`, polling fetched only the newest 100, returned 101, and advanced the cursor to 101. IDs 1–100 were never inspected. See [wait engine](../src/wait.ts). | P0 |
| An already-cancelled wait throws an internal error | A pre-aborted signal produced `ReferenceError: Cannot access 'deadlineTimer' before initialization`. | P0 |

Additional findings from code inspection:

| Finding | Evidence and implication | Priority |
|---|---|---|
| HTTP boundary validation can fail open | On a non-loopback bind without an allowlist, [http.ts](../src/http.ts) skips both Host and Origin validation. Docker defaults to that bind. A warning does not enforce the boundary. | P0 |
| Credential-retention claims are inaccurate | [SECURITY.md](../SECURITY.md) and [auth.ts](../src/auth.ts) say raw keys are never stored, but every cached [FmsgClient](../src/client/client.ts) retains its key in memory for renewal. Eviction runs only on new cache insertion; the configured TTL is not a reliable idle-retention bound. | P0 |
| Untrusted-content framing and redaction are inconsistent | Inbox/sent previews and the wait path without thread context omit the full data preamble. Headers precede the preamble on other paths. Direct tool errors, partial failures, and some logs bypass centralized sanitization. See [rendering](../src/render.ts), [errors](../src/errors.ts), and tool handlers. | P0 |
| MCP calls can lose the client request timeout | [client.ts](../src/client/client.ts) chooses the caller's signal instead of combining it with the request deadline. Tools normally supply a signal. The Node-to-Web request adapter also needs disconnect/cancellation verification. | P0 |
| Authenticated HTTP is limited to fmsg API keys | No OAuth discovery/authorization flow. Good for explicitly configured clients, insufficient for universal per-user hosted onboarding. The single MCP `fmsg` scope is not itself a messaging-authorization defect: fmsg-webapi enforces the authenticated identity's access. | P1 |
| Wait and payload defaults are awkward across hosts | Wait defaults to 90 seconds. Bodies in wait results and the message resource are unbounded, and attachment downloads buffer the entire file before enforcing the inline cap. Thread truncation also happens after retrieval. | P1 |
| Failed sends can have an uncertain outcome | Any exception after draft creation triggers attempted deletion. If send committed but its response was lost, the model receives a generic error with no draft ID or reconciliation guidance and may send a duplicate. | P1 |
| Compatibility evidence and MCP Registry version lag | Tests use the same TypeScript SDK family; CI runs on Linux. npm publishing works, including provenance; the separate MCP Registry listing still advertises 0.1.0 while npm has 0.1.4, and the workflow has no MCP Registry publication step. README setup combines distinct host formats and overgeneralizes remote-header onboarding. | P1 |

P0 means fix before increasing adoption or recommending shared public deployment. P1 means required for the intended broad-integration release. P2 below covers enhancements that should not delay core correctness.

**1. Preserve upstream authorization and secure MCP boundaries**

Keep fmsg-webapi and the fmsg host services authoritative for messaging access and quotas. The MCP server is an authenticated client of that API. A second message ACL, recipient/domain allowlist, send quota, or read-only account model in MCP would create configuration drift and inconsistent behavior across clients. These are not part of this workstream.

| Concern | Authority | fmsg-mcp responsibility |
|---|---|---|
| Identity, grants, ownership, message/thread/attachment visibility, and allowed message actions | fmsg-webapi | Bind every operation to the request's caller and forward it using that caller's upstream credential; never substitute a more privileged identity |
| Address status, quotas, message acceptance, and delivery policy | fmsg host services, including fmsgid/fmsgd, through fmsg-webapi | Surface host errors and per-recipient delivery outcomes; do not copy quota or recipient-policy logic |
| Whether a particular agent action is authorized by the user's task | AI host and its user/administrator configuration | Provide accurate descriptions, annotations, and workflow guidance; never treat received messages as authorization to invoke tools |
| MCP HTTP access, cross-caller isolation, credentials, local file I/O, and process resource use | fmsg-mcp and its deployment | Enforce these boundaries locally because the upstream API cannot protect them |

The current Web API contract says protected requests re-check the backing grant/key, including expiry and revocation. Inbox visibility is scoped to exactly the authenticated identity. Preserve and test those guarantees through MCP instead of maintaining a local authorization cache. Existing token/client caching is for connection efficiency, not an authoritative permission decision. [fmsg-webapi contract](https://github.com/markmnl/fmsg-webapi#api-keys-and-first-party-jwts).

Separate service permission from user intent: an account may be allowed to send a message, but that does not authorize the agent to send one merely because an inbound message requests it. The host owns tool-use permissions and approval policy. MCP guidance should support explicit user instructions and bounded automation without requiring redundant approval for already-authorized work. Annotations are hints, not proof that a user approved an action.

For this workstream, plan these changes and checks:

1. **Document and verify the caller boundary.** Audit every tool, resource, attachment route, and wait/WebSocket path for use of the resolved caller. Add tests for concurrent identities and denied access by guessed message IDs, thread IDs, and attachment names. Denial must propagate without fallback to another credential or identity.
2. **Make upstream decisions reliable for the agent.** Preserve host status/code and secret-redacted error text, including partial delivery results. Test permission denial, host-configured limits, expired/revoked keys, and identity-service failure. Refresh/retry only as the documented client contract allows; an upstream denial must never become a local success. Extend the real-stack acceptance tests for authoritative behavior rather than assuming the fake server proves it.
3. **Correct tool semantics and untrusted-content handling.** Audit read/write/send annotations, expose reply-all and recipient-expansion effects clearly, apply data framing to all message-content paths, and centralize error/log redaction. Keep `terminal` and `no_reply` workflow safeguards; the API remains authoritative for permitted message operations. Test content presentation deterministically, and record prompt-injection behavior in host integration evaluations without claiming universal prevention.
4. **Close capabilities introduced by MCP.** Fix attachment filesystem writes, HTTP validation, and credential-cache lifecycle using the concrete requirements below. Test these as local boundaries independently of upstream access checks.

Do not add a read-only MCP profile or tool-specific authorization scopes in this phase. If users later need a credential that can read but cannot send, prefer an upstream grant/key capability usable by all clients. Host tool restrictions can support agent-specific workflows where the host enforces them. Any future advertised OAuth scope must be enforced, ideally through the corresponding upstream grant; design that delegation separately without recreating message ownership or quota policy.

Make attachment download truly read-only by default: return bounded content or a resource reference. Immediately correct annotations for any retained filesystem-writing path. Move saving into a separately advertised, explicitly enabled stdio tool with a configured download directory. Default to creating a new file, refuse overwrite and symlink traversal, and use a filesystem strategy that accounts for races; a `realpath` check followed by an ordinary write is insufficient against concurrent path changes. If portable confinement cannot be guaranteed, delegate saving to the host's file tool. Test nested symlinks, existing targets, traversal, permissions, and Windows paths.

Require explicit allowed hosts for non-loopback HTTP startup, validate Origin independently, and define browser origins by scheme, host, and port. Provide narrow CORS preflight support before bearer authentication for allowed origins, including the necessary MCP request/response headers. CORS permission must never substitute for authentication. Supply a working TLS reverse-proxy example and reject insecure upstream API URLs outside an explicit local/private-development configuration. Validate URLs structurally, reject embedded credentials, and constrain authenticated redirects.

Centralize error/log sanitization, including SDK/transport failures, partial per-item errors, configuration errors, and untrusted host error strings. Document that keys live in process memory and are not intentionally persisted. Enforce cache-entry expiration before reuse, run bounded idle eviction, clear clients on shutdown, and deduplicate concurrent authentication for the same key. Propagate the Web API's rejection of revoked or expired grants and invalidate unusable cached clients appropriately. Check long-lived WebSocket revocation behavior separately from protected HTTP requests; do not infer it from token expiry or MCP cache TTL.

Treat message bodies, subjects, filenames, reactions, previews, host errors, and structured results as untrusted data. Put the preamble before untrusted text on every rendering path. Keep sender and source metadata clear without claiming that labels prevent prompt injection. Place the irreversible-send and user-authorization guidance early in server instructions and keep descriptions specific to fmsg behavior. Test malicious message content against the MCP-owned boundaries and the host's actual tool-use controls. Ensure reaction annotations match the repository's external-send convention.

Keep redaction claims precise: current regular expressions cover selected secret formats; they do not prevent arbitrary exfiltration or inspect binary attachments. Define the exported client's redaction contract too. Text attachment checks, if added, must be explicit; avoid silently corrupting binary files. Server controls cannot prevent an agent from using unrelated tools, so document the host's responsibility as well.

**2. Make messaging reliable under failures and load**

Rework catch-up to scan to a known cursor boundary with bounded work and an explicit continuation when incomplete. Handle insertion during offset pagination, reconnects, out-of-order events, batches larger than 20, and multiple threads. Track what was returned, intentionally skipped, pending, or unknown. Never advance beyond unseen work. A fallback that cannot establish completeness must report that fact and hold a safe cursor. If the upstream API needs a stable cursor endpoint, coordinate that change instead of promising lossless behavior from unstable pagination.

Combine caller cancellation, a per-upstream-request deadline, and the overall tool deadline. Propagate disconnects through HTTP adapters and terminate sockets, timers, and in-flight fetches promptly. Prevent overlapping catch-up scans. Add a short polling option and choose a default wait below the shortest timeout in the verified host matrix, with headroom for result assembly. Longer waits remain available in tested configurations. Codex currently documents a 60-second default tool timeout, below this server's 90-second wait default. [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Bound bytes while reading streams, before buffering. Apply consistent budgets to text, structured results, resources, and attachments; expose truncation and continuation metadata. Support useful text-only fallbacks and avoid returning the same image payload twice. Provide a practical attachment-upload workflow that does not require a model to manufacture megabytes of base64: use host-supported attachment references or an explicitly enabled, confined local file adapter after validating supported host capabilities.

Protect the MCP service with configurable request-body, connection, concurrent-wait, per-principal, and authentication-attempt budgets. Preserve timeouts for receiving HTTP request bodies; a long-running response does not require unlimited body-ingest time. Distinguish these infrastructure/output budgets from fmsg message-size and acceptance policy. Continue surfacing the fmsg host's responses and delivery codes; do not invent host limits.

Make send outcomes explicit: accepted, definitely failed before send, or unknown after possible commit. Preserve the draft/message ID for reconciliation and use an independent bounded cleanup deadline. Do not blindly delete or resend when commit status is unknown. Coordinate durable idempotency with fmsg-webapi if needed; an in-memory MCP cache cannot provide exactly-once sending across crashes and replicas. Prefer a caller-supplied operation ID with atomic upstream enforcement, payload binding, and defined retention. Until then, return actionable uncertainty and require reconciliation before retrying.

Introduce stable machine-readable error information: code, operation, retryability, safe retry delay, upstream status/code/text, and recovery action. Preserve readable `isError` results. Specify how this fits output schemas and older clients before rollout; plain MCP errors are not inherently invalid merely because they lack `structuredContent`. Handle partial success explicitly. Use bounded backoff for safe reads on transient failures, respect `Retry-After`, and never apply generic mutation retries.

**3. Provide two first-class connection paths**

For local development and controlled agents, retain stdio with environment/secret-store configuration and explicit API-key HTTP support. Keep secrets out of tool arguments, URLs, examples containing real values, and shared configuration. Document the trust implications of giving a remote MCP operator an upstream key.

For hosted applications, add a standard OAuth connection: protected-resource metadata and challenges, authorization-server discovery, PKCE, short-lived audience-bound MCP access tokens, consent to the linked fmsg identity/grant, refresh, and revocation. OAuth secures access to the MCP service; it does not require duplicating fmsg ownership and quota rules. Advertise only scopes whose restrictions are actually enforced, preferring upstream delegation when narrower access is required. Prefer Client ID Metadata Documents (CIMD); support pre-registration and DCR only where the chosen compatibility matrix needs them. DCR is deprecated in the 2026-07-28 specification. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

Use an established authorization-server implementation and keep the integration provider-neutral. `CallerProvider` is the natural seam, but OAuth identity must map through a trusted account link to an fmsg address and usable upstream authorization. Prefer delegated credentials supported by fmsg-webapi. If a gateway must retain an upstream credential, design its encrypted storage, access controls, disconnect cleanup, and retention explicitly. Validate MCP tokens at the MCP boundary and use separate upstream credentials; never forward an incoming OAuth token to an arbitrary upstream URL.

This needs coordination with the fmsg host/account system; it is more than adding a login endpoint to this repository. Keep one configured upstream per deployment initially. Supporting arbitrary upstream hosts later requires a separate routing, SSRF, issuer-trust, and tenant-isolation design.

Correct the README's claim that a claude.ai user can simply enter their own bearer header. Current Claude docs describe static headers as an organization-admin beta with a shared credential, which does not establish per-user fmsg identity. OAuth is the appropriate default for that use case. [Claude connector authentication](https://claude.com/docs/connectors/building/authentication). OpenAI's hosted plugin authentication similarly describes OAuth discovery and account authorization. [OpenAI authentication](https://developers.openai.com/plugins/build/auth).

Keep prompts, resources, richer content, and long-running-task features optional. Core messaging must work through tool calls and text. Consider the `io.modelcontextprotocol/tasks` extension only after correctness and short-wait fallback are established and supported hosts are verified. Current MCP guidance moves Tasks into an extension and deprecates several older features; adding every advertised protocol feature would increase maintenance without guaranteeing interoperability. [2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

**4. Prove integration and make setup self-diagnosing**

Publish separate, executable examples and a version/date-stamped compatibility matrix:

| Integration family | Supported path to prove | Specific checks |
|---|---|---|
| Codex CLI/app/IDE | stdio; HTTP bearer; HTTP OAuth | TOML configuration, environment-based secrets, startup and tool timeout, tool approvals |
| Claude Code / Desktop | Separate stdio and HTTP recipes where supported | Correct installation format, credential storage, prompts optional, per-user identity |
| Cursor / VS Code | Distinct configuration files and schemas | Correct top-level keys, secret inputs, Windows process launch, remote-workspace behavior |
| ChatGPT hosted / claude.ai | HTTPS OAuth | Discovery, consent, refresh, reconnect, disconnect, account isolation, actual product/plan restrictions |
| Custom agent frameworks | Official TypeScript and Python MCP clients first | Protocol negotiation, plain-text consumption, resources/prompts unavailable, cancellation |
| Agents without native MCP | Documented adapter or exported client | Explicitly identify the adapter dependency; avoid claiming direct compatibility |

Label each entry verified, experimental, or unsupported. Test real product builds before advertising support. Sources for host-specific recipes include [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code](https://code.claude.com/docs/en/mcp), and [VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

Add a non-sending `doctor` command with human and JSON output: configuration validity, runtime/version, DNS/TLS/API reachability, token exchange, resolved identity, MCP discovery, and the precise next corrective action. Keep local protocol discovery fast when upstream authentication is slow. Provide a first-run sequence of install → doctor → whoami → list inbox. Any delivery smoke test should use dedicated test accounts and be clearly identified as sending.

CI should install the actual packed artifact in a clean directory and verify CLI launch, exports/types, stdio, HTTP, and missing-credential discovery. Add Windows and macOS to the supported Node/OS matrix. Exercise an independent Python client to avoid same-SDK assumptions. Use the official [MCP conformance suite](https://github.com/modelcontextprotocol/conformance) for applicable transport/schema/auth scenarios, with no unexplained exclusions. Preserve the existing real two-host acceptance suite and pin its upstream fixture revision for release checks; separately test moving upstream versions on a schedule.

Test current `2026-07-28` and selected legacy revisions explicitly. Verify discovery/initialization as appropriate to each revision, metadata headers, JSON/SSE responses, cancellation, malformed requests, concurrent users, and schema-valid outputs. Modern Streamable HTTP specifies `Mcp-Method` and `Mcp-Name`; validate their forwarding through CORS/proxies and rely on the SDK's version-aware implementation. Do not infer wire compatibility from the SDK's major version alone. [Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

**5. Release trust: existing controls and incremental uplifts**

Release-triggered npm publication is already implemented and working. Treat the following as existing controls to preserve, not new work:

| Existing capability | Verified evidence |
|---|---|
| GitHub release → public npm package | [publish.yml](../.github/workflows/publish.yml) runs on published, non-prerelease GitHub releases. The [v0.1.4 run](https://github.com/markmnl/fmsg-mcp/actions/runs/34083669828) succeeded and [npm metadata](https://registry.npmjs.org/@markmnl%2ffmsg-mcp/0.1.4) records version 0.1.4 and commit `329b803da877dc24e581e26dd436b8fe47752b62`. |
| Trusted publishing and generated provenance | OIDC-capable workflow and a [published SLSA provenance statement](https://registry.npmjs.org/-/npm/v1/attestations/@markmnl%2ffmsg-mcp@0.1.4) naming this repository, `.github/workflows/publish.yml`, tag `v0.1.4`, and the matching commit. Provenance generation does not need to be implemented again. |
| Version synchronization | Release tag validation and updates to package metadata and `server.json` already happen before publication. |
| Checks before npm publication | Clean dependency installation, typecheck, build, unit tests, and package dry-run are already in the release workflow. The package's `prepack` also rebuilds and tests. |
| Broader repository CI | Node 22/24, Docker build/version smoke test, and real two-host acceptance are already configured in [tests.yml](../.github/workflows/tests.yml). Their execution on the release commit is a separate release-gating question. |
| Package identity and maintenance basics | MIT license, repository/issues/homepage metadata, narrow package file list, SECURITY.md with private-report instructions, CODEOWNERS, and substantive [GitHub release notes](https://github.com/markmnl/fmsg-mcp/releases) already exist. |
| MCP Registry discovery | The [official latest entry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.markmnl%2Ffmsg-mcp/versions/latest) exists and is active, but still points to package/version 0.1.0 at review time. |

GitHub trusted npm publishing automatically generates provenance for eligible public packages. This package already has it. Ongoing verification can be automated as an incremental check; do not describe provenance itself as missing. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

The concrete release/discovery work is:

1. **Keep the existing MCP Registry listing current.** Add metadata publication after successful npm publication, validate the manifest, and query back the exact version. Existing version synchronization can be reused. A failed registry update should be retryable without republishing an immutable npm version. npm and the MCP Registry are separate services: npm hosts the package; the MCP Registry advertises how to install/connect to it. [Official registry publication automation](https://modelcontextprotocol.io/registry/github-actions).
2. **Test the exact distributable.** Extend the existing build/test/dry-run process to install and smoke-test the tarball in a clean directory, then publish that same tarball. Verify executable launch, exports/types, and discovery without credentials. This belongs with work package D; implement it once.
3. **Strengthen release inputs.** Pin third-party Actions and release build inputs and add reviewed dependency updates. Check that required CI results cover the release commit. Repository protections, maintainer account security, and private-reporting settings need inspection before being classified as missing. Include SECURITY.md in the published file list and keep its claims accurate.

SBOMs, additional automated security scans, published multi-architecture container images with attestations, and host-directory listings are further improvements, not prerequisites for retaining the working npm release path. Prioritize them according to the distribution/deployment paths actually supported. A registry listing or provenance record establishes discoverability/origin, not a security certification.

Continue the existing release notes; a separate CHANGELOG.md is optional. Add concise compatibility/deprecation and support policies and CONTRIBUTING.md where helpful. CODEOWNERS already identifies the maintainer; any backup-maintainer arrangement is an operational decision, not a missing metadata file. Expand security/privacy documentation to accurately describe data flow, credential storage, metadata logging, retention, deletion/disconnection, and hosted-service responsibilities. For broad hosted launch, plan a focused independent review of authentication, file handling, cross-user isolation, and MCP-owned safety boundaries.

For shared deployments, add privacy-preserving structured logs and metrics: operation, outcome, latency, auth failures, active waits, reconnects, backlog lag, upstream errors, memory use, and release version. Avoid message bodies and tokens; keep address logging restricted to operational need. Separate liveness from readiness without revealing credentials or treating one user's bad key as a global outage. Document graceful draining, rotation, rollback, incident response, and abuse handling. Load-test the declared deployment envelope before publishing availability or latency promises.

**Proposed implementation sequence**

Effort below is a planning range in focused engineering days, including targeted tests/docs, for one engineer familiar with the code. External host changes and review waiting time are additional; these are not delivery commitments.

| Work package | Scope | Exit criteria | Dependency | Effort |
|---|---|---|---|---|
| A — Immediate safety patch | File-write boundary, correct hints, mandatory HTTP validation, pre-aborted wait, sanitized errors, truthful key documentation/cache behavior | File-write and pre-cancelled-wait reproductions become regression tests; file/HTTP/cancellation boundaries pass; security claims match implementation | None | 4–7 days |
| B — Receive reliability | Pagination/cursor invariants, ordering, reconnect, pending batches, cancellation/deadlines, bounded response assembly | Backlog/burst tests prove no unseen message is passed; disconnects release work; budgets are enforced while streaming | A | 4–7 days |
| C — Safe actions and outcomes | Upstream authorization/error propagation tests, send uncertainty, error contract; upstream idempotency design | Upstream denials survive MCP unchanged except secret redaction; committed-but-lost responses cannot trigger blind resend | A; upstream agreement for durable idempotency | 3–5 days locally |
| D — Painless local integration | Doctor, separate recipes, short wait defaults, clean-package and OS/Python/conformance tests | A new user reaches whoami/inbox without debugging configuration; supported clients have recorded passing results | A/B; start recipe work earlier | 4–7 days |
| E — Hosted OAuth | Auth architecture/account linkage, discovery, consent/scopes, refresh/revocation, hosted-client tests | Two simultaneous users retain correct identity; disconnect/refresh work; account and token isolation tests pass | A/C; fmsg host/account-system support | 8–15+ days |
| F — Incremental release trust and operations | Existing MCP Registry version synchronization, release-input hardening, remaining policies; hosted metrics/runbooks/review as applicable. npm publication, provenance generation, metadata versioning, and existing checks are already complete | MCP Registry matches npm; release inputs/checks are traceable; exact-tarball tests are shared with D; hosted-operation criteria apply only to supported hosted deployments | D; E for hosted launch | Re-estimate release-only work separately from hosted operations; no effort for completed controls |

Ship A first, then B–D as an integration-hardening release. Plan E with the fmsg host maintainer before committing a date. F's supply-chain work can begin earlier, but broad hosted promotion should wait for E and the independent review. This is several weeks of work, with the remote authorization/account-linking design carrying the largest uncertainty.

**Definition of done for the broad-integration release**

- Fresh installs on every claimed OS/client can identify the account and read the inbox using the documented path, with a target of under five minutes after credentials/account access are available.
- No P0 defect remains; caller isolation and upstream messaging authorization hold across tools/resources, and tools advertised as read-only cannot write files or cause messaging mutations.
- Receive tests cover thousands of queued messages, interleaved threads, reconnects, cancellations, and out-of-order events without silent cursor loss.
- Tool deadlines fit the verified host configuration; operations stop promptly on cancellation, and large inputs/outputs remain inside the declared service envelope.
- Ambiguous sends return a durable reference/recovery path; retries cannot silently create duplicates under the documented guarantees.
- Every advertised remote per-user integration passes OAuth identity, scope, refresh, revocation, and tenant-isolation checks in the actual host.
- The packed npm artifact, registry metadata, release version, provenance, documented configuration, and published compatibility results agree.

P2 candidates after these gates: additional language-client examples, host-specific push adapters, desktop bundles, optional task/subscription support, and enterprise authorization integration. Adopt them when a verified user workflow needs them; keep the core messaging contract small and portable.
