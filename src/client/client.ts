import { normalizeFmsgAddress } from "../address.js";
import { normalizeMessageId, parseFmsgJson, stringifyWithIds } from "./message-id.js";
import { redactSecrets } from "./redact.js";
import { normalizeApiUrl } from "./url.js";
import { readBytes, withIdleTimeout } from "./stream.js";
import type {
  AccessToken,
  Attachment,
  FmsgMessage,
  ReactResult,
  SendInput,
  SendResult,
  Thread,
} from "./types.js";

export type FetchLike = typeof fetch;

export type FmsgClientOptions = {
  fetch?: FetchLike;
  /** Refresh the access token this long before it expires (default 5 minutes). */
  refreshMarginMs?: number;
  /** Per-request timeout; attachment streams use separate header/idle budgets (default 60 s). */
  timeoutMs?: number;
  /** Allow HTTP outside loopback only on an explicitly trusted network. */
  allowInsecureHttp?: boolean;
};

/** An HTTP error from the fmsg Web API, with the status and the host's own error text. */
export class FmsgHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    /** Machine-readable `code` from the body, when the host sends one (thread routes). */
    readonly code?: string,
  ) {
    super(redactSecrets(message).text);
    if (this.code) this.code = redactSecrets(this.code).text;
    this.method = redactSecrets(method).text;
    this.path = redactSecrets(path).text;
    this.name = "FmsgHttpError";
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("token exchange returned an invalid JWT");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("token exchange returned an unreadable JWT payload");
  }
}

async function readError(response: Response): Promise<{ message: string; code?: string }> {
  // Preserve canonical 400/413 JSON policy details. Other errors, including
  // proxy pages, get a bounded preview independent of message acceptance limits.
  const isJson = (response.headers.get("content-type") ?? "").toLowerCase().includes("json");
  let raw: string;
  if (!isJson || ![400, 413].includes(response.status)) {
    const { data, truncated } = await readBytes(response.body, 2048, true);
    raw = Buffer.from(data).toString("utf8");
    if (!isJson || truncated) return { message: (raw || `HTTP ${response.status}`) + (truncated ? "\n[upstream response truncated at 2048 bytes]" : "") };
  } else raw = await response.text();
  if (!raw) return { message: `HTTP ${response.status}` };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; code?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : `HTTP ${response.status}`;
    return typeof parsed.code === "string" ? { message, code: parsed.code } : { message };
  } catch {
    return { message: Buffer.byteLength(raw) > 2048 ? Buffer.from(raw).subarray(0, 2048).toString("utf8") + "\n[upstream response truncated at 2048 bytes]" : raw };
  }
}

function withId(message: FmsgMessage, id: string): FmsgMessage {
  return { ...message, id, terminal: message.terminal === true, reaction: message.reaction ?? null, reactions: message.reactions ?? [] };
}

/**
 * Client for the fmsg Web API (FMSG-003). Exchanges an `fmsgk_` API key for a
 * short-lived JWT, refreshes it ahead of expiry, and retries once on 401.
 */
export class FmsgClient {
  readonly apiUrl: string;
  private token?: AccessToken;
  private tokenPromise?: Promise<AccessToken>;
  private readonly lifetime = new AbortController();

  constructor(
    apiUrl: string,
    private apiKey: string,
    private readonly options: FmsgClientOptions = {},
  ) {
    this.apiUrl = normalizeApiUrl(apiUrl, options.allowInsecureHttp);
    if (!apiKey.startsWith("fmsgk_")) throw new Error("fmsg API key must start with fmsgk_");
  }

  private get fetchImpl(): FetchLike {
    return this.options.fetch ?? fetch;
  }

  /** The address this client acts as (from the JWT `sub`), exchanging the key if needed. */
  async address(): Promise<string> {
    return (await this.getToken()).address;
  }

  async getToken(force = false): Promise<AccessToken> {
    this.lifetime.signal.throwIfAborted();
    const margin = this.options.refreshMarginMs ?? 300_000;
    if (this.tokenPromise) return this.tokenPromise;
    if (!force && this.token && this.token.expiresAtMs - margin > Date.now()) return this.token;
    this.tokenPromise = this.exchangeToken();
    try {
      this.token = await this.tokenPromise;
      this.lifetime.signal.throwIfAborted();
      return this.token;
    } catch (error) {
      this.token = undefined;
      throw error;
    } finally {
      this.tokenPromise = undefined;
    }
  }

  /** Release credentials and cancel outstanding work when the client is no longer used. */
  close(): void {
    this.lifetime.abort();
    this.apiKey = "";
    this.token = undefined;
  }

  private async exchangeToken(): Promise<AccessToken> {
    const response = await this.fetchImpl(`${this.apiUrl}/fmsg/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      redirect: "error",
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.options.timeoutMs ?? 60_000)]),
    });
    if (!response.ok) {
      const { message, code } = await readError(response);
      throw new FmsgHttpError(`token exchange failed: ${message}`, response.status, "POST", "/fmsg/token", code);
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown; expires_at?: unknown };
    if (typeof body.access_token !== "string") throw new Error("token response has no access_token");
    const payload = decodeJwtPayload(body.access_token);
    const address = typeof payload.sub === "string" ? normalizeFmsgAddress(payload.sub) : undefined;
    if (!address) throw new Error("token JWT sub is not an fmsg address");
    const fromResponse = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
    const fromJwt = typeof payload.exp === "number" ? payload.exp * 1000 : Number.NaN;
    const fromIn = typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : Number.NaN;
    const expiresAtMs = [fromResponse, fromJwt, fromIn].find(Number.isFinite) ?? Date.now() + 3_600_000;
    return { accessToken: body.access_token, address, expiresAtMs };
  }

  private async request(path: string, init: RequestInit = {}, retry401 = true, streaming = false): Promise<Response> {
    init.signal?.throwIfAborted();
    const token = await this.getToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token.accessToken}`);
    const headerDeadline = new AbortController();
    const headerTimer = streaming ? setTimeout(() => headerDeadline.abort(new DOMException("attachment response headers timed out", "TimeoutError")), this.options.timeoutMs ?? 60_000).unref() : undefined;
    const timeout = streaming ? headerDeadline.signal : AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const signal = AbortSignal.any([this.lifetime.signal, timeout, ...(init.signal ? [init.signal] : [])]);
    try {
      signal.throwIfAborted();
      const response = await this.fetchImpl(`${this.apiUrl}${path}`, { ...init, headers, signal, redirect: "error" });
      if (response.status === 401 && retry401) {
        await response.body?.cancel();
        await this.getToken(true);
        return this.request(path, init, false, streaming);
      }
      if (!response.ok) {
        const { message, code } = await readError(response);
        const method = init.method ?? "GET";
        throw new FmsgHttpError(message, response.status, method, path, code);
      }
      return response;
    } finally { clearTimeout(headerTimer); }
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    return parseFmsgJson<T>(await response.text());
  }

  // ── Messages ──────────────────────────────────────────────────────────

  async listInbox(limit = 20, offset = 0, signal?: AbortSignal): Promise<FmsgMessage[]> {
    const items = await this.json<FmsgMessage[]>(`/fmsg?limit=${limit}&offset=${offset}`, { signal });
    if (!Array.isArray(items)) throw new Error("inbox response is not an array");
    return items.map((m) => withId(m, normalizeMessageId(m.id)));
  }

  async listSent(limit = 20, offset = 0, signal?: AbortSignal): Promise<FmsgMessage[]> {
    const items = await this.json<FmsgMessage[]>(`/fmsg/sent?limit=${limit}&offset=${offset}`, { signal });
    if (!Array.isArray(items)) throw new Error("sent response is not an array");
    return items.map((m) => withId(m, normalizeMessageId(m.id)));
  }

  async getMessage(id: string, signal?: AbortSignal): Promise<FmsgMessage> {
    const mid = normalizeMessageId(id);
    const message = await this.json<FmsgMessage>(`/fmsg/${encodeURIComponent(mid)}`, { signal });
    return withId(message, mid);
  }

  /** Raw message body bytes. */
  async getData(id: string, signal?: AbortSignal): Promise<{ data: Uint8Array; contentType?: string }> {
    const mid = normalizeMessageId(id);
    const response = await this.request(`/fmsg/${encodeURIComponent(mid)}/data`, { signal });
    const contentType = response.headers.get("content-type") ?? undefined;
    return { data: new Uint8Array(await response.arrayBuffer()), ...(contentType ? { contentType } : {}) };
  }

  /** Whether `short_text` already holds the complete body. */
  static shortTextIsComplete(message: FmsgMessage): boolean {
    if (typeof message.short_text !== "string") return false;
    if (typeof message.size !== "number") return false;
    return Buffer.byteLength(message.short_text, "utf8") >= message.size;
  }

  static isText(message: { type?: string }): boolean {
    const type = (message.type ?? "").toLowerCase();
    return type.startsWith("text/") || type.startsWith("application/json") || /\+json\b/u.test(type);
  }

  /** Full body text for text-like messages; null for binary bodies. */
  async getText(message: FmsgMessage, signal?: AbortSignal): Promise<string | null> {
    if (!FmsgClient.isText(message)) return null;
    if (FmsgClient.shortTextIsComplete(message)) return message.short_text ?? "";
    if (message.size === 0) return "";
    const { data } = await this.getData(message.id, signal);
    return Buffer.from(data).toString("utf8");
  }

  async getThreadMessages(id: string, signal?: AbortSignal): Promise<Thread> {
    const mid = normalizeMessageId(id);
    const thread = await this.json<Thread>(`/fmsg/${encodeURIComponent(mid)}/thread/messages`, { signal });
    return {
      ...thread,
      root_id: normalizeMessageId(thread.root_id, "root_id"),
      trigger_id: normalizeMessageId(thread.trigger_id, "trigger_id"),
      messages: (thread.messages ?? []).map((m) => ({ ...m, id: normalizeMessageId(m.id) })),
    };
  }

  async getThreadText(id: string, signal?: AbortSignal): Promise<string> {
    const mid = normalizeMessageId(id);
    const response = await this.request(`/fmsg/${encodeURIComponent(mid)}/thread`, { signal });
    return response.text();
  }

  /** Download by a `download` path returned from thread/messages (`/fmsg/...`). */
  async downloadPath(path: string, signal?: AbortSignal): Promise<{ data: Uint8Array; contentType?: string }> {
    // Paths come from upstream message data. Reject normalization tricks and
    // routes outside the documented body/attachment download endpoints.
    if (!/^\/fmsg\/[0-9]+\/(?:data|attach\/[^/?#\\]+)$/u.test(path) || /[\u0000-\u0020\\]/u.test(path)) {
      throw new Error("refusing an invalid fmsg download path");
    }
    const normalized = new URL(path, "https://example.com");
    if (normalized.pathname !== path || normalized.search || normalized.hash) throw new Error("refusing an invalid fmsg download path");
    const response = await this.request(path, { signal });
    const contentType = response.headers.get("content-type") ?? undefined;
    return { data: new Uint8Array(await response.arrayBuffer()), ...(contentType ? { contentType } : {}) };
  }

  async markRead(id: string, signal?: AbortSignal): Promise<{ id: string; time_read: number | null }> {
    const mid = normalizeMessageId(id);
    const result = await this.json<{ id: unknown; time_read?: number | null }>(`/fmsg/${encodeURIComponent(mid)}/read`, {
      method: "POST",
      signal,
    });
    return { id: mid, time_read: result.time_read ?? null };
  }

  async addRecipients(id: string, addTo: string[], signal?: AbortSignal): Promise<{ id: string; added: number }> {
    const mid = normalizeMessageId(id);
    const result = await this.json<{ id: unknown; added?: number }>(`/fmsg/${encodeURIComponent(mid)}/add-to`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ add_to: addTo }),
      signal,
    });
    return { id: mid, added: result.added ?? addTo.length };
  }

  async react(id: string, emoji: string | null, signal?: AbortSignal): Promise<ReactResult> {
    const mid = normalizeMessageId(id);
    const result = await this.json<{ id?: unknown; time?: number | null }>(`/fmsg/${encodeURIComponent(mid)}/react`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji: emoji ?? "" }),
      signal,
    });
    return {
      id: result.id === undefined || result.id === null ? null : normalizeMessageId(result.id),
      time: result.time ?? null,
    };
  }

  async downloadAttachment(
    id: string,
    filename: string,
    signal?: AbortSignal,
    maxBytes?: number,
  ): Promise<{ data: Uint8Array; contentType?: string }> {
    const { stream, contentType } = await this.streamAttachment(id, filename, signal);
    const { data } = await readBytes(stream, maxBytes);
    return { data, ...(contentType ? { contentType } : {}) };
  }

  /** Caller must consume or cancel the stream. Progress resets the idle budget; cancellation remains active. */
  async streamAttachment(id: string, filename: string, signal?: AbortSignal): Promise<{ stream: ReadableStream<Uint8Array>; contentType?: string }> {
    const mid = normalizeMessageId(id);
    if (!filename || filename === "." || filename === ".." || /[/\\\u0000]/u.test(filename)) {
      throw new Error("use an attachment filename without directory components");
    }
    const response = await this.request(
      `/fmsg/${encodeURIComponent(mid)}/attach/${encodeURIComponent(filename)}`,
      { signal },
      true, true,
    );
    const contentType = response.headers.get("content-type") ?? undefined;
    if (!response.body) throw new Error("attachment response has no body");
    return { stream: withIdleTimeout(response.body, this.options.timeoutMs ?? 60_000), ...(contentType ? { contentType } : {}) };
  }

  async deleteMessage(id: string, signal?: AbortSignal): Promise<void> {
    const mid = normalizeMessageId(id);
    await this.request(`/fmsg/${encodeURIComponent(mid)}`, { method: "DELETE", signal });
  }

  // ── Sending ───────────────────────────────────────────────────────────

  private async createDraft(input: SendInput, from: string): Promise<string> {
    const body: Record<string, unknown> = {
      version: 1,
      from,
      to: input.to,
      type: input.type ?? "text/markdown; charset=utf-8",
      data: input.body,
      topic: input.pid ? "" : (input.topic ?? ""),
      ...(input.important ? { important: true } : {}),
      ...(input.noReply ? { no_reply: true } : {}),
    };
    const serialized = input.pid ? stringifyWithIds(body, { pid: input.pid }) : JSON.stringify(body);
    const response = await this.request("/fmsg", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serialized,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const result = parseFmsgJson<{ id?: unknown }>(await response.text());
    if (result.id === undefined || result.id === null) throw new Error("draft response has no id");
    return normalizeMessageId(result.id);
  }

  async uploadAttachment(draftId: string, attachment: { filename: string; data: Uint8Array; contentType?: string }, signal?: AbortSignal): Promise<Attachment> {
    const form = new FormData();
    const blob = new Blob([Buffer.from(attachment.data)], { type: attachment.contentType ?? "application/octet-stream" });
    form.append("file", blob, attachment.filename);
    const response = await this.request(`/fmsg/${encodeURIComponent(draftId)}/attach`, {
      method: "POST",
      body: form,
      ...(signal ? { signal } : {}),
    });
    const result = parseFmsgJson<{ filename?: string; size?: number }>(await response.text());
    return { filename: result.filename ?? attachment.filename, size: result.size ?? attachment.data.byteLength };
  }

  /**
   * Draft → attach → send. Selected secret patterns in body/topic are replaced;
   * the result reports their count and the sent topic. Attachments are unchanged.
   * The draft is deleted if any step after creation fails.
   */
  async send(input: SendInput): Promise<SendResult> {
    if (input.to.length === 0) throw new Error("at least one recipient is required");
    if (input.pid && input.topic) throw new Error("a reply (pid) cannot carry a topic");
    const from = await this.address();
    const body = redactSecrets(input.body);
    const topic = redactSecrets(input.pid ? "" : (input.topic ?? ""));
    const draftId = await this.createDraft({ ...input, body: body.text, topic: topic.text }, from);
    try {
      const attachments: Attachment[] = [];
      for (const attachment of input.attachments ?? []) {
        attachments.push(await this.uploadAttachment(draftId, attachment, input.signal));
      }
      const response = await this.request(`/fmsg/${encodeURIComponent(draftId)}/send`, {
        method: "POST",
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const result = parseFmsgJson<{ id?: unknown; time?: number | null }>(await response.text());
      return {
        id: result.id === undefined || result.id === null ? draftId : normalizeMessageId(result.id),
        time: result.time ?? null,
        attachments,
        redactions: body.count + topic.count,
        topic: topic.text,
      };
    } catch (error) {
      await this.deleteMessage(draftId).catch(() => undefined);
      throw error;
    }
  }
}
