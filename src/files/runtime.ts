/**
 * Server-side state of the file-uploads extension, shared by every MCP server instance an HTTP process creates:
 * the HMAC key for requestState and upload targets, the calls waiting for uploads, and the uploads this process has
 * verified. File bytes are never kept here: an upload target streams them into the fmsg draft the call created.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type RequestStateCodec, type ServerContext, createRequestStateCodec } from "@modelcontextprotocol/server";
import type { FilesConfig } from "../config.js";
import type { Caller } from "../context.js";
import { UPLOAD_METHOD, UPLOADS_KEY } from "./extension.js";

export const TARGET_PATH = "/mcp/uploads";

/** What an upload target accepts, signed into its URL. Short keys keep the URL short. */
export type TargetClaims = {
  v: 1;
  /** The fmsg address the target was issued to; the upload must authenticate as it. */
  a: string;
  /** The draft the file goes into. */
  d: string;
  /** FileInput.id. */
  f: string;
  /** Attachment name. */
  n: string;
  /** Declared size. */
  s: number;
  /** Declared SHA-256, lowercase hex. */
  h: string;
  /** Media type. */
  t: string;
  /** The call (round) it belongs to. */
  r: string;
  /** Expiry, unix seconds. */
  e: number;
};

/** One file waiting for its upload, as recorded in requestState. */
export type PendingFile = { id: string; filename: string; size: number; sha256: string; mimeType: string };

/**
 * The requestState payload of a call waiting for uploads. It is signed, not encrypted: the client can read it, so it
 * holds nothing secret. `summary` is the tool's own data for building its result after the uploads.
 */
export type RoundState = {
  v: 1;
  tool: string;
  /** argumentsHash of the call's arguments. */
  args: string;
  address: string;
  draft: string;
  round: string;
  /** Expiry of the targets, unix seconds. */
  exp: number;
  files: PendingFile[];
  summary: Record<string, unknown>;
};

export type UploadTarget = { fileId: string; url: string; headers: Record<string, string>; credentials: "omit" | "include" };
export type UploadInputRequest = { method: typeof UPLOAD_METHOD; params: { files: UploadTarget[] } };

type RoundStatus = "open" | "running" | "done" | "ended";
type Round = { status: RoundStatus; draft: string; caller: Caller; outcome?: string; reaper?: NodeJS.Timeout; forget?: NodeJS.Timeout };

/** Per-request scope set by the HTTP layer, so a tool handler can attach its upload request to its own response. */
type UploadScope = { offers: Map<string, UploadInputRequest> };

/** How long requestState stays verifiable after its targets expire, so a late retry gets a specific answer. */
const STATE_GRACE_SECONDS = 3600;
/** How long after the targets expire an abandoned call's draft is deleted. */
const REAP_DELAY_MS = 60_000;

export class FilesRuntime {
  readonly codec: RequestStateCodec<RoundState>;
  private readonly key: Buffer;
  /** True when the key is configured, so other instances may serve this process's calls. */
  readonly shared: boolean;
  private readonly rounds = new Map<string, Round>();
  /** Uploads this process received and verified, by `${draft}/${filename}`: the bytes' SHA-256. */
  private readonly verified = new Map<string, string>();
  private readonly uploading = new Set<string>();
  private readonly scope = new AsyncLocalStorage<UploadScope>();
  private closed = false;

  constructor(readonly config: FilesConfig, readonly publicUrl: string, private readonly log: (line: string) => void = () => undefined) {
    this.shared = Boolean(config.stateSecret);
    this.key = config.stateSecret ? Buffer.from(config.stateSecret, "utf8") : randomBytes(32);
    this.codec = createRequestStateCodec<RoundState>({
      key: this.key,
      ttlSeconds: config.targetTtlSeconds + STATE_GRACE_SECONDS,
      // The spec binds requestState to the authenticated principal: the fmsg address the caller acts as.
      bind: (ctx: ServerContext) => principalOf(ctx),
    });
  }

  // ── Upload targets ──────────────────────────────────────────────────

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(`fmsg-mcp.upload-target.v1:${body}`).digest("base64url");
  }

  targetUrl(claims: TargetClaims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${this.publicUrl.replace(/\/$/u, "")}/uploads/${body}.${this.sign(body)}`;
  }

  /** The claims of a target token from a request path, or why it is not usable. */
  verifyTarget(token: string, now = Date.now()): { claims: TargetClaims } | { problem: "unknown" | "expired"; claims?: TargetClaims } {
    const [body, mac, extra] = token.split(".");
    if (!body || !mac || extra !== undefined) return { problem: "unknown" };
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { problem: "unknown" };
    let claims: TargetClaims;
    try { claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TargetClaims; }
    catch { return { problem: "unknown" }; }
    if (claims.v !== 1) return { problem: "unknown" };
    if (claims.e * 1000 <= now) return { problem: "expired", claims };
    return { claims };
  }

  /** The upload request for a call: one target per pending file, PUT with this connection's credential. */
  uploadRequest(state: RoundState): UploadInputRequest {
    return {
      method: UPLOAD_METHOD,
      params: {
        files: state.files.map((f) => ({
          fileId: f.id,
          url: this.targetUrl({ v: 1, a: state.address, d: state.draft, f: f.id, n: f.filename, s: f.size, h: f.sha256, t: f.mimeType, r: state.round, e: state.exp }),
          headers: { "Content-Type": f.mimeType },
          credentials: "include",
        })),
      },
    };
  }

  // ── Calls waiting for uploads ───────────────────────────────────────

  newRound(caller: Caller, draft: string): { round: string; exp: number } {
    const round = randomUUID();
    const exp = Math.floor(Date.now() / 1000) + this.config.targetTtlSeconds;
    const entry: Round = { status: "open", draft, caller };
    // A call abandoned before its retry leaves its draft behind. With a per-process key only this process can
    // complete the call, so it is safe to delete the draft once the targets expire. With a shared key another
    // instance may have completed it, and create_draft's result is itself a draft, so nothing is deleted.
    if (!this.shared) entry.reaper = setTimeout(() => void this.reap(round), this.config.targetTtlSeconds * 1000 + REAP_DELAY_MS).unref();
    entry.forget = setTimeout(() => this.forget(round), (this.config.targetTtlSeconds + STATE_GRACE_SECONDS) * 1000).unref();
    this.rounds.set(round, entry);
    return { round, exp };
  }

  status(round: string): { status: RoundStatus; outcome?: string } | undefined {
    const entry = this.rounds.get(round);
    return entry && { status: entry.status, ...(entry.outcome ? { outcome: entry.outcome } : {}) };
  }

  /** Move a call to `status`. Returns false when a call another retry is running cannot be claimed. */
  mark(round: string, status: RoundStatus, outcome?: string, caller?: Caller, draft?: string): boolean {
    let entry = this.rounds.get(round);
    if (!entry) {
      // A call from another instance (shared key): track it here from now on.
      if (!caller || !draft) return true;
      entry = { status: "open", draft, caller };
      entry.forget = setTimeout(() => this.forget(round), STATE_GRACE_SECONDS * 1000).unref();
      this.rounds.set(round, entry);
    }
    if (status === "running" && entry.status !== "open") return false;
    entry.status = status;
    if (outcome) entry.outcome = outcome;
    if (status === "done" || status === "ended") {
      clearTimeout(entry.reaper);
      for (const key of [...this.verified.keys()]) if (key.startsWith(`${entry.draft}/`)) this.verified.delete(key);
    }
    return true;
  }

  private forget(round: string): void {
    const entry = this.rounds.get(round);
    if (!entry) return;
    clearTimeout(entry.reaper);
    clearTimeout(entry.forget);
    this.rounds.delete(round);
  }

  /** Delete an abandoned call's draft, if it is still an unsent draft. */
  private async reap(round: string): Promise<void> {
    const entry = this.rounds.get(round);
    if (!entry || entry.status !== "open" || this.closed) return;
    entry.status = "ended";
    entry.outcome = "its upload targets expired without a retry, so its draft was deleted";
    try {
      const draft = await entry.caller.client.getMessage(entry.draft);
      if (draft.time === null || draft.time === undefined) await entry.caller.client.deleteMessage(entry.draft);
    } catch (error) {
      this.log(`file uploads: could not delete abandoned draft ${entry.draft}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── Uploads received ────────────────────────────────────────────────

  /** Claim a target for one upload at a time; false when another upload to it is in progress. */
  begin(key: string): boolean {
    if (this.uploading.has(key)) return false;
    this.uploading.add(key);
    return true;
  }

  end(key: string): void {
    this.uploading.delete(key);
  }

  recordVerified(key: string, sha256: string): void {
    this.verified.set(key, sha256);
  }

  verifiedSha256(key: string): string | undefined {
    return this.verified.get(key);
  }

  // ── Delivering the upload request ───────────────────────────────────

  /**
   * Attach `request` to the input_required response carrying `requestState`. The SDK accepts only the input request
   * kinds the base protocol defines (the draft notes it needs a core MRTR extension point), so a tool returns an
   * input_required result with requestState alone and the HTTP layer adds the upload request to that response.
   * False when this request was not served through serve().
   */
  offer(requestState: string, request: UploadInputRequest): boolean {
    const scope = this.scope.getStore();
    if (!scope) return false;
    scope.offers.set(requestState, request);
    return true;
  }

  /** Serve one MCP HTTP request, adding any upload request a tool offered to its input_required result. */
  async serve(fetch: () => Promise<Response>): Promise<Response> {
    const scope: UploadScope = { offers: new Map() };
    const response = await this.scope.run(scope, fetch);
    const type = response.headers.get("content-type") ?? "";
    if (!response.body || !(type.startsWith("application/json") || type.startsWith("text/event-stream"))) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    if (type.startsWith("application/json")) {
      // A JSON response is written after the handler returned, so any offer is already recorded.
      if (!scope.offers.size) return response;
      const patched = withUploadRequests(await response.text(), scope.offers);
      return new Response(patched, { status: response.status, statusText: response.statusText, headers });
    }
    return new Response(response.body.pipeThrough(sseRewriter(scope.offers)), { status: response.status, statusText: response.statusText, headers });
  }

  close(): void {
    this.closed = true;
    for (const entry of this.rounds.values()) { clearTimeout(entry.reaper); clearTimeout(entry.forget); }
    this.rounds.clear();
    this.verified.clear();
  }
}

/** The fmsg address a request is authenticated as: the API-key client id, or the OAuth caller's address. */
export function principalOf(ctx: ServerContext): string {
  const auth = ctx.http?.authInfo;
  const address = auth?.extra?.address;
  return (typeof address === "string" ? address : auth?.clientId ?? "").toLowerCase();
}

/** Add offered upload requests to the input_required result(s) in a JSON-RPC message (or batch). */
function withUploadRequests(text: string, offers: Map<string, UploadInputRequest>): string {
  let message: unknown;
  try { message = JSON.parse(text); } catch { return text; }
  let changed = false;
  const patch = (m: unknown) => {
    const result = (m as { result?: { resultType?: unknown; requestState?: unknown; inputRequests?: Record<string, unknown> } } | null)?.result;
    if (!result || result.resultType !== "input_required" || typeof result.requestState !== "string") return;
    const offer = offers.get(result.requestState);
    if (!offer) return;
    result.inputRequests = { ...(result.inputRequests ?? {}), [UPLOADS_KEY]: offer };
    changed = true;
  };
  if (Array.isArray(message)) message.forEach(patch);
  else patch(message);
  return changed ? JSON.stringify(message) : text;
}

/** Rewrite SSE `data:` payloads that carry an offered input_required result; everything else passes unchanged. */
function sseRewriter(offers: Map<string, UploadInputRequest>): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const flushEvents = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
    for (;;) {
      const end = buffer.search(/\r?\n\r?\n/u);
      if (end < 0) break;
      const separator = /\r?\n\r?\n/u.exec(buffer.slice(end))![0];
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + separator.length);
      controller.enqueue(encoder.encode(rewriteEvent(event, offers) + separator));
    }
    if (final && buffer) { controller.enqueue(encoder.encode(rewriteEvent(buffer, offers))); buffer = ""; }
  };
  return new TransformStream({
    transform(chunk, controller) { buffer += decoder.decode(chunk, { stream: true }); flushEvents(controller, false); },
    flush(controller) { buffer += decoder.decode(); flushEvents(controller, true); },
  });
}

function rewriteEvent(event: string, offers: Map<string, UploadInputRequest>): string {
  if (!offers.size) return event;
  const lines = event.split(/\r?\n/u);
  const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /u, "")).join("\n");
  if (!data) return event;
  const patched = withUploadRequests(data, offers);
  if (patched === data) return event;
  return [...lines.filter((l) => !l.startsWith("data:")), `data: ${patched}`].join("\n");
}
