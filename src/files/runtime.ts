/**
 * Server-side state of the file-uploads extension, shared by every MCP server instance an HTTP process creates:
 * the HMAC key for requestState and upload targets, the calls waiting for uploads, and the uploads this process has
 * verified. File bytes are never kept here: an upload target streams them into the fmsg draft the call created.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type InputRequiredResult, MissingRequiredClientCapabilityError, type RequestStateCodec, type ServerContext, createRequestStateCodec, inputRequired,
} from "@modelcontextprotocol/server";
import type { FilesConfig } from "../config.js";
import type { Caller } from "../context.js";
import { FILES_EXTENSION, declaredSettings } from "./extension.js";

/** Where upload targets are served; clients reach it as the `path` /uploads/{token} under the MCP address /mcp. */
export const TARGET_PATH = "/mcp/uploads";

/** What an upload target accepts, signed into its path. Short keys keep the path short. */
export type TargetClaims = {
  v: 2;
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
  /** Declared SHA-256, lowercase hex, when the client gave a digest. */
  h?: string;
  /** Media type. */
  t: string;
  /** The call (round) it belongs to. */
  r: string;
  /** Latest start time for the upload, unix seconds. */
  e: number;
};

/** One file waiting for its upload, as recorded in requestState. */
export type PendingFile = { id: string; filename: string; size: number; sha256?: string; mimeType: string };

/**
 * The requestState payload of a call waiting for uploads. It is signed, not encrypted: the client can read it, so it
 * holds nothing secret. `summary` is the tool's own data for building its result after the uploads.
 */
export type RoundState = {
  v: 2;
  tool: string;
  /** argumentsHash of the call's arguments. */
  args: string;
  address: string;
  draft: string;
  round: string;
  /** When the targets stop accepting new uploads, unix seconds. */
  exp: number;
  files: PendingFile[];
  summary: Record<string, unknown>;
};

/** An UploadTarget as the spec defines it; this server issues only `path` targets with the MCP credential. */
export type UploadTarget = {
  fileId: string;
  path: string;
  method: "PUT";
  headers: Record<string, string>;
  credentials: "include";
  expiresAt: string;
};
export type UploadRequiredResult = { resultType: "upload_required"; uploads: UploadTarget[]; requestState: string };
type JsonRpcError = { code: number; message: string; data?: unknown };

/** What the HTTP layer puts in place of a tool's input_required result: an upload request or a JSON-RPC error. */
type Replacement = { result: UploadRequiredResult } | { error: JsonRpcError };

type RoundStatus = "open" | "running" | "done" | "ended";
type Round = { status: RoundStatus; draft: string; caller: Caller; outcome?: string; reaper?: NodeJS.Timeout; forget?: NodeJS.Timeout };

/** Per-request scope set by the HTTP layer: what the request declared, and the replacements its tools asked for. */
type RequestScope = { method?: string; declared: boolean; replacements: Map<string, Replacement> };

/**
 * How long requestState stays valid after the targets stop accepting new uploads: a transfer started just before
 * then, plus the retry. The spec asks for a lifetime that covers both.
 */
const RETRY_WINDOW_SECONDS = 900;
const INVALID_PARAMS = -32602;
/** MissingRequiredClientCapabilityError, which the spec answers with HTTP 400. */
const MISSING_CAPABILITY = -32021;

export class FilesRuntime {
  readonly codec: RequestStateCodec<RoundState>;
  private readonly key: Buffer;
  /** True when the key is configured, so other instances may serve this process's calls. */
  readonly shared: boolean;
  private readonly rounds = new Map<string, Round>();
  /** Uploads this process received and verified, by `${draft}/${filename}`: the bytes' SHA-256. */
  private readonly verified = new Map<string, string>();
  private readonly uploading = new Set<string>();
  private readonly scope = new AsyncLocalStorage<RequestScope>();
  private closed = false;

  constructor(readonly config: FilesConfig, private readonly log: (line: string) => void = () => undefined) {
    this.shared = Boolean(config.stateSecret);
    this.key = config.stateSecret ? Buffer.from(config.stateSecret, "utf8") : randomBytes(32);
    this.codec = createRequestStateCodec<RoundState>({
      key: this.key,
      ttlSeconds: config.targetTtlSeconds + RETRY_WINDOW_SECONDS,
      // The spec binds requestState to the authenticated principal: the fmsg address the caller acts as.
      bind: (ctx: ServerContext) => principalOf(ctx),
    });
  }

  // ── Upload targets ──────────────────────────────────────────────────

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(`fmsg-mcp.upload-target.v2:${body}`).digest("base64url");
  }

  /** The target's `path`, relative to the client's MCP address. */
  targetPath(claims: TargetClaims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `/uploads/${body}.${this.sign(body)}`;
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
    if (claims.v !== 2) return { problem: "unknown" };
    if (claims.e * 1000 <= now) return { problem: "expired", claims };
    return { claims };
  }

  /** The upload request for a call: one PUT target per pending file, sent with this connection's credential. */
  uploadRequest(state: RoundState, requestState: string): UploadRequiredResult {
    const expiresAt = new Date(state.exp * 1000).toISOString();
    return {
      resultType: "upload_required",
      uploads: state.files.map((f) => ({
        fileId: f.id,
        path: this.targetPath({
          v: 2, a: state.address, d: state.draft, f: f.id, n: f.filename, s: f.size, ...(f.sha256 ? { h: f.sha256 } : {}), t: f.mimeType, r: state.round, e: state.exp,
        }),
        method: "PUT",
        headers: { "Content-Type": f.mimeType },
        credentials: "include",
        expiresAt,
      })),
      requestState,
    };
  }

  // ── Calls waiting for uploads ───────────────────────────────────────

  newRound(caller: Caller, draft: string): { round: string; exp: number } {
    const round = randomUUID();
    const exp = Math.floor(Date.now() / 1000) + this.config.targetTtlSeconds;
    const entry: Round = { status: "open", draft, caller };
    const lifetime = (this.config.targetTtlSeconds + RETRY_WINDOW_SECONDS) * 1000;
    // A call abandoned before its retry leaves its draft behind. With a per-process key only this process can
    // complete the call, so the draft is deleted once its requestState expires. With a shared key another instance
    // may have completed it, and create_draft's result is itself a draft, so nothing is deleted.
    if (!this.shared) entry.reaper = setTimeout(() => void this.reap(round), lifetime + 60_000).unref();
    entry.forget = setTimeout(() => this.forget(round), lifetime + 120_000).unref();
    this.rounds.set(round, entry);
    return { round, exp };
  }

  status(round: string): { status: RoundStatus; outcome?: string } | undefined {
    const entry = this.rounds.get(round);
    return entry && { status: entry.status, ...(entry.outcome ? { outcome: entry.outcome } : {}) };
  }

  /** Move a call to `status`. Returns false when a call that is not open cannot be claimed to run. */
  mark(round: string, status: RoundStatus, outcome?: string, caller?: Caller, draft?: string): boolean {
    let entry = this.rounds.get(round);
    if (!entry) {
      // A call from another instance (shared key): track it here from now on.
      if (!caller || !draft) return true;
      entry = { status: "open", draft, caller };
      entry.forget = setTimeout(() => this.forget(round), (this.config.targetTtlSeconds + RETRY_WINDOW_SECONDS) * 1000).unref();
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
    entry.outcome = "no retry arrived before its requestState expired, so its draft was deleted";
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

  // ── Results the SDK cannot return ───────────────────────────────────

  /**
   * Answer the current tools/call with an upload request. McpServer validates a tool's result as a CallToolResult
   * unless it is input_required, so the tool returns input_required carrying `requestState` and the HTTP layer
   * puts the upload request in its place. Undefined when this request was not served through serve().
   */
  requestUploads(result: UploadRequiredResult): InputRequiredResult | undefined {
    return this.replace(result.requestState, { result });
  }

  /**
   * Answer the current tools/call with a JSON-RPC error. McpServer turns anything a tool throws into a tool error,
   * so this rides the same seam as requestUploads. Undefined when this request was not served through serve().
   */
  protocolError(error: JsonRpcError): InputRequiredResult | undefined {
    return this.replace(`fmsg-mcp.error.${randomUUID()}`, { error });
  }

  /** -32602, for a retry whose requestState does not match the call, or was already used. */
  invalidRequestState(reason: string): InputRequiredResult | undefined {
    return this.protocolError({ code: INVALID_PARAMS, message: `Invalid or expired requestState: ${reason}`, data: { reason: "invalid_request_state" } });
  }

  /** -32021, for a file without data on a request that did not declare `upload`. */
  missingUpload(): InputRequiredResult | undefined {
    const error = new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [FILES_EXTENSION]: { upload: {} } } } });
    return this.protocolError({ code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) });
  }

  private replace(marker: string, replacement: Replacement): InputRequiredResult | undefined {
    const scope = this.scope.getStore();
    if (!scope) return undefined;
    scope.replacements.set(marker, replacement);
    return inputRequired({ requestState: marker });
  }

  /**
   * Whether tool schemas list FileInputs on this request. A tools/list that did not declare the extension gets the
   * tools without them, as the spec asks; every tools/call accepts them, since inline FileInputs need no declaration.
   */
  listsFileInputs(): boolean {
    const scope = this.scope.getStore();
    return !scope || scope.method !== "tools/list" || scope.declared;
  }

  /**
   * Serve one MCP HTTP request: note what it declared, and put any replacement a tool asked for in place of its
   * input_required result. `body` is the parsed JSON-RPC message when the caller already has it.
   */
  async serve(request: Request, body: unknown, fetch: () => Promise<Response>): Promise<Response> {
    if (body === undefined && request.method === "POST" && (request.headers.get("content-type") ?? "").includes("json")) {
      body = await request.clone().json().catch(() => undefined);
    }
    const message = body as { method?: unknown; params?: { _meta?: unknown } } | undefined;
    const scope: RequestScope = {
      ...(typeof message?.method === "string" ? { method: message.method } : {}),
      declared: declaredSettings(message?.params?._meta) !== undefined,
      replacements: new Map(),
    };
    const response = await this.scope.run(scope, fetch);
    const type = response.headers.get("content-type") ?? "";
    if (!response.body || !(type.startsWith("application/json") || type.startsWith("text/event-stream"))) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    if (type.startsWith("application/json")) {
      // A JSON response is written after the handler returned, so any replacement is already recorded.
      if (!scope.replacements.size) return response;
      const { text, status } = applyReplacements(await response.text(), scope.replacements);
      return new Response(text, { status: status ?? response.status, statusText: status ? "" : response.statusText, headers });
    }
    return new Response(response.body.pipeThrough(sseRewriter(scope.replacements)), { status: response.status, statusText: response.statusText, headers });
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

/**
 * Put replacements in place of the input_required results that carry their markers, in a JSON-RPC message or batch.
 * `status` is set when the HTTP status should change: -32021 is answered with 400.
 */
function applyReplacements(text: string, replacements: Map<string, Replacement>): { text: string; status?: number } {
  let message: unknown;
  try { message = JSON.parse(text); } catch { return { text }; }
  let changed = false;
  let status: number | undefined;
  const patch = (m: unknown) => {
    const response = m as { result?: { resultType?: unknown; requestState?: unknown }; error?: unknown } | null;
    const result = response?.result;
    if (!result || result.resultType !== "input_required" || typeof result.requestState !== "string") return;
    const replacement = replacements.get(result.requestState);
    if (!replacement) return;
    if ("result" in replacement) response.result = replacement.result;
    else {
      delete response.result;
      response.error = replacement.error;
      if (replacement.error.code === MISSING_CAPABILITY) status = 400;
    }
    changed = true;
  };
  if (Array.isArray(message)) message.forEach(patch);
  else patch(message);
  return changed ? { text: JSON.stringify(message), ...(status ? { status } : {}) } : { text };
}

/** Rewrite SSE `data:` payloads that carry a replaced input_required result; everything else passes unchanged. */
function sseRewriter(replacements: Map<string, Replacement>): TransformStream<Uint8Array, Uint8Array> {
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
      controller.enqueue(encoder.encode(rewriteEvent(event, replacements) + separator));
    }
    if (final && buffer) { controller.enqueue(encoder.encode(rewriteEvent(buffer, replacements))); buffer = ""; }
  };
  return new TransformStream({
    transform(chunk, controller) { buffer += decoder.decode(chunk, { stream: true }); flushEvents(controller, false); },
    flush(controller) { buffer += decoder.decode(); flushEvents(controller, true); },
  });
}

/** One SSE event with its payload replaced. The HTTP status is already sent, so -32021 keeps it. */
function rewriteEvent(event: string, replacements: Map<string, Replacement>): string {
  if (!replacements.size) return event;
  const lines = event.split(/\r?\n/u);
  const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /u, "")).join("\n");
  if (!data) return event;
  const { text } = applyReplacements(data, replacements);
  if (text === data) return event;
  return [...lines.filter((l) => !l.startsWith("data:")), `data: ${text}`].join("\n");
}
