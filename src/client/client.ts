import { normalizeFmsgAddress } from "../address.js";
import { normalizeMessageId, parseFmsgJson, stringifyWithIds } from "./message-id.js";
import { redactSecrets } from "./redact.js";
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
  /** Per-request timeout (default 60 s). */
  timeoutMs?: number;
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
    super(message);
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
  const raw = await response.text().catch(() => "");
  if (!raw) return { message: `HTTP ${response.status}` };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; code?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : `HTTP ${response.status}`;
    return typeof parsed.code === "string" ? { message, code: parsed.code } : { message };
  } catch {
    return { message: raw.slice(0, 300) };
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

  constructor(
    apiUrl: string,
    private readonly apiKey: string,
    private readonly options: FmsgClientOptions = {},
  ) {
    this.apiUrl = apiUrl.replace(/\/+$/u, "");
    if (!/^https?:\/\//u.test(this.apiUrl)) throw new Error("FMSG_API_URL must be an http(s) URL");
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
    const margin = this.options.refreshMarginMs ?? 300_000;
    if (!force && this.token && this.token.expiresAtMs - margin > Date.now()) return this.token;
    if (!force && this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this.exchangeToken();
    try {
      this.token = await this.tokenPromise;
      return this.token;
    } finally {
      this.tokenPromise = undefined;
    }
  }

  private async exchangeToken(): Promise<AccessToken> {
    const response = await this.fetchImpl(`${this.apiUrl}/fmsg/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    });
    if (!response.ok) {
      const { message } = await readError(response);
      throw new FmsgHttpError(`token exchange failed: ${redactSecrets(message).text}`, response.status, "POST", "/fmsg/token");
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

  private async request(path: string, init: RequestInit = {}, retry401 = true): Promise<Response> {
    const token = await this.getToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token.accessToken}`);
    const signal = init.signal ?? AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, { ...init, headers, signal });
    if (response.status === 401 && retry401) {
      await this.getToken(true);
      return this.request(path, init, false);
    }
    if (!response.ok) {
      const { message, code } = await readError(response);
      const method = init.method ?? "GET";
      throw new FmsgHttpError(redactSecrets(message).text, response.status, method, path, code);
    }
    return response;
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
    if (!path.startsWith("/fmsg/") || path.includes("://")) throw new Error(`refusing to download non-fmsg path ${path}`);
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
  ): Promise<{ data: Uint8Array; contentType?: string }> {
    const mid = normalizeMessageId(id);
    const response = await this.request(
      `/fmsg/${encodeURIComponent(mid)}/attach/${encodeURIComponent(filename)}`,
      { signal },
    );
    const contentType = response.headers.get("content-type") ?? undefined;
    return { data: new Uint8Array(await response.arrayBuffer()), ...(contentType ? { contentType } : {}) };
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

  /** Draft → attach → send. The draft is deleted if any step after creation fails. */
  async send(input: SendInput): Promise<SendResult> {
    if (input.to.length === 0) throw new Error("at least one recipient is required");
    if (input.pid && input.topic) throw new Error("a reply (pid) cannot carry a topic");
    const from = await this.address();
    const draftId = await this.createDraft(input, from);
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
      };
    } catch (error) {
      await this.deleteMessage(draftId).catch(() => undefined);
      throw error;
    }
  }
}
