import { normalizeFmsgAddress } from "../address.js";
import { normalizeMessageId, parseFmsgJson, stringifyWithIds } from "./message-id.js";
import { redactSecrets } from "./redact.js";
import { normalizeApiUrl } from "./url.js";
import { readBytes, withIdleTimeout } from "./stream.js";
import { FmsgHttpError, readError } from "./errors.js";
import { ApiKeyTokenProvider, type TokenProvider } from "./token-provider.js";
import type {
  AccessToken,
  Attachment,
  FmsgMessage,
  ReactResult,
  SendInput,
  SendResult,
  Thread,
} from "./types.js";

export { FmsgHttpError } from "./errors.js";

export type FetchLike = typeof fetch;

export type FmsgClientOptions = {
  fetch?: FetchLike;
  /** Refresh margin (default 5 minutes), capped at half the token's remaining lifetime on acquisition. */
  refreshMarginMs?: number;
  /** Per-request timeout; attachment streams use separate header/idle budgets (default 60 s). */
  timeoutMs?: number;
  /** Allow HTTP outside loopback only on an explicitly trusted network. */
  allowInsecureHttp?: boolean;
};

function withId(message: FmsgMessage, id: string): FmsgMessage {
  return { ...message, id, terminal: message.terminal === true, reaction: message.reaction ?? null, reactions: message.reactions ?? [] };
}

type TokenRenewal = { promise: Promise<AccessToken>; abort: AbortController; waiters: number };

/** Detach one waiter without cancelling work another caller still needs. */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    // Always observe the operation, including a provider that ignores cancellation.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Client for the fmsg Web API (FMSG-003). Accepts an API key or a caller-bound
 * token provider, renews tokens ahead of expiry, and retries once on 401.
 */
export class FmsgClient {
  readonly apiUrl: string;
  private token?: AccessToken;
  private renewal?: TokenRenewal;
  private provider?: TokenProvider;
  private boundAddress?: string;
  private refreshAtMs = 0;
  private readonly lifetime = new AbortController();

  constructor(
    apiUrl: string,
    credentials: string | TokenProvider,
    private readonly options: FmsgClientOptions = {},
  ) {
    this.apiUrl = normalizeApiUrl(apiUrl, options.allowInsecureHttp);
    if (options.refreshMarginMs !== undefined && (!Number.isFinite(options.refreshMarginMs) || options.refreshMarginMs < 0)) {
      throw new Error("refreshMarginMs must be a finite non-negative number");
    }
    this.provider = typeof credentials === "string" ? new ApiKeyTokenProvider(credentials, this.fetchImpl) : credentials;
    if (!this.provider || typeof this.provider.getToken !== "function") throw new Error("a token provider must implement getToken");
  }

  private get fetchImpl(): FetchLike {
    return this.options.fetch ?? fetch;
  }

  /** The provider's authenticated address, pinned for this client's lifetime. */
  async address(signal?: AbortSignal): Promise<string> {
    return (await this.getToken(false, signal)).address;
  }

  async getToken(force = false, signal?: AbortSignal): Promise<AccessToken> {
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (!this.renewal && !force && this.token && this.refreshAtMs > Date.now()) return this.token;
    const renewal = this.renewal ?? this.startRenewal(force);
    renewal.waiters++;
    try {
      return await withAbort(renewal.promise, signal);
    } finally {
      renewal.waiters--;
      if (!renewal.waiters && this.renewal === renewal) {
        this.renewal = undefined;
        renewal.abort.abort();
      }
    }
  }

  private startRenewal(forceRefresh: boolean): TokenRenewal {
    const provider = this.provider!;
    const renewal: TokenRenewal = { promise: undefined!, abort: new AbortController(), waiters: 0 };
    this.renewal = renewal;
    this.token = undefined;
    const signal = AbortSignal.any([this.lifetime.signal, renewal.abort.signal]);
    const timer = setTimeout(() => renewal.abort.abort(new DOMException("token renewal timed out", "TimeoutError")), this.options.timeoutMs ?? 60_000).unref();
    const acquiring = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return provider.getToken({ apiUrl: this.apiUrl, signal, forceRefresh });
    });
    renewal.promise = withAbort(acquiring, signal).then(value => {
      signal.throwIfAborted();
      const address = typeof value?.address === "string" ? normalizeFmsgAddress(value.address) : undefined;
      if (!address) throw new Error("token provider returned an invalid fmsg address");
      if (typeof value.accessToken !== "string" || !/^[A-Za-z0-9._~+\/-]+=*$/u.test(value.accessToken) || value.accessToken.startsWith("fmsgk_")) {
        throw new Error("token provider must return a Web API bearer access token");
      }
      const now = Date.now();
      if (!Number.isFinite(value.expiresAtMs) || value.expiresAtMs <= now) throw new Error("token provider returned an invalid or expired token lifetime");
      if (this.boundAddress !== undefined && address !== this.boundAddress) throw new Error("token provider changed the authenticated address; create a new client for a different identity");
      this.boundAddress = address;
      const token = Object.freeze({ accessToken: value.accessToken, address, expiresAtMs: value.expiresAtMs });
      this.refreshAtMs = token.expiresAtMs - Math.min(this.options.refreshMarginMs ?? 300_000, (token.expiresAtMs - now) / 2);
      this.token = token;
      return token;
    }).finally(() => {
      clearTimeout(timer);
      if (this.renewal === renewal) this.renewal = undefined;
    });
    return renewal;
  }

  /** Release credentials and cancel outstanding work when the client is no longer used. */
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.token = undefined;
    const provider = this.provider;
    this.provider = undefined;
    provider?.close?.();
  }

  private async request(path: string, init: RequestInit = {}, retry401 = true, streaming = false): Promise<Response> {
    init.signal?.throwIfAborted();
    const token = await this.getToken(false, init.signal ?? undefined);
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
        // A slower 401 may refer to a token another request already renewed.
        if (!this.token || this.token === token || this.token.expiresAtMs <= Date.now()) {
          await this.getToken(true, init.signal ?? undefined);
        }
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
    const from = await this.address(input.signal);
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
