/**
 * In-memory stand-in for fmsg-webapi (FMSG-003) covering the routes fmsg-mcp
 * uses: token exchange, inbox/sent, drafts, send, read, add-to, react, data,
 * attachments, thread/messages, thread text and the event WebSocket.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

export type StoredMessage = {
  id: string;
  version: number;
  pid: string | null;
  from: string;
  to: string[];
  to_delivery: Array<{ addr: string; time_delivered: string | null; response_code: number | null }>;
  add_to: Array<{ batch_id: string; add_to_from: string; to: string[]; to_delivery: Array<{ addr: string; time_delivered: string | null; response_code: number | null }>; time: number }>;
  time: number | null;
  topic: string;
  type: string;
  data: Buffer;
  important: boolean;
  no_reply: boolean;
  terminal: boolean;
  attachments: Array<{ filename: string; size: number; data: Buffer; type: string }>;
  reaction: string | null;
  readBy: Map<string, number>;
  deleted: boolean;
};

export type SeedInput = Partial<Omit<StoredMessage, "data" | "readBy" | "attachments" | "add_to" | "to_delivery">> & {
  from: string;
  to: string[];
  data?: string | Buffer;
  attachments?: Array<{ filename: string; data: Buffer; type?: string }>;
};

export type LoggedRequest = { method: string; path: string; body?: unknown; rawBody?: string };

const ID_FIELDS = /"(id|pid|batch_id|root_id|trigger_id)":"([0-9]+)"/gu;

function jwt(sub: string, expSeconds: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub, exp: expSeconds, iss: "fake" })}.sig`;
}

function subjectOf(token: string | undefined): string | undefined {
  if (!token || token.startsWith("fmsgk_")) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: string; exp?: number };
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return undefined;
    return payload.sub;
  } catch {
    return undefined;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function isText(type: string): boolean {
  const t = type.toLowerCase();
  return t.startsWith("text/") || t.startsWith("application/json") || /\+json\b/u.test(t);
}

export class FakeFmsgServer {
  private readonly http = createServer((req, res) => void this.handle(req, res));
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Map<string, Set<WebSocket>>();
  readonly messages = new Map<string, StoredMessage>();
  readonly requests: LoggedRequest[] = [];
  readonly apiKeys = new Map<string, string>([
    ["fmsgk_alice_secret", "@alice@example.com"],
    ["fmsgk_bob_secret", "@bob@example.net"],
    ["fmsgk_carol_secret", "@carol@example.org"],
  ]);
  /** Fail the next request whose path matches, with this status and message. */
  failNext: { match: RegExp; status: number; error: string; code?: string } | undefined;
  /** Force the next protected request to answer 401 (expired JWT simulation). */
  rejectNextProtected = false;
  /** Make thread/messages answer 422 thread_too_deep. */
  threadTooDeep = false;
  shortTextBytes = 768;
  tokenTtlSeconds = 3600;
  private nextId = 100;
  private url?: string;
  private clock = 1_700_000_000;

  constructor() {
    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/fmsg/ws") return socket.destroy();
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/iu, "");
      const subject = subjectOf(bearer ?? url.searchParams.get("access_token") ?? undefined);
      if (!subject) {
        socket.write("HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n\r\n{\"error\":\"unauthorized\"}");
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const set = this.sockets.get(subject) ?? new Set<WebSocket>();
        set.add(ws);
        this.sockets.set(subject, set);
        ws.on("close", () => set.delete(ws));
      });
    });
  }

  get baseUrl(): string {
    if (!this.url) throw new Error("fake server not started");
    return this.url;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.http.listen(0, "127.0.0.1", resolve));
    const { port } = this.http.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const set of this.sockets.values()) for (const ws of set) ws.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  now(): number {
    this.clock += 1;
    return this.clock;
  }

  connectedSockets(address: string): number {
    return this.sockets.get(address)?.size ?? 0;
  }

  seed(input: SeedInput): StoredMessage {
    const id = input.id ?? String(this.nextId++);
    const n = Number(id);
    if (Number.isSafeInteger(n)) this.nextId = Math.max(this.nextId, n + 1);
    const data = typeof input.data === "string" ? Buffer.from(input.data, "utf8") : (input.data ?? Buffer.alloc(0));
    const sent = input.time === undefined ? this.now() : input.time;
    const message: StoredMessage = {
      id,
      version: 1,
      pid: input.pid ?? null,
      from: input.from,
      to: input.to,
      to_delivery: input.to.map((addr) => ({ addr, time_delivered: sent === null ? null : new Date((sent + 1) * 1000).toISOString(), response_code: sent === null ? null : 200 })),
      add_to: [],
      time: sent,
      topic: input.topic ?? "",
      type: input.type ?? "text/plain; charset=utf-8",
      data,
      important: input.important ?? false,
      no_reply: input.no_reply ?? false,
      terminal: input.terminal ?? false,
      attachments: (input.attachments ?? []).map((a) => ({ filename: a.filename, size: a.data.byteLength, data: a.data, type: a.type ?? "application/octet-stream" })),
      reaction: input.reaction ?? null,
      readBy: new Map(),
      deleted: false,
    };
    this.messages.set(id, message);
    return message;
  }

  /** Deliver a stored message to its recipients' sockets as a new_msg event. */
  push(message: StoredMessage): void {
    const recipients = new Set([...message.to, ...message.add_to.flatMap((b) => b.to)]);
    for (const addr of recipients) {
      for (const ws of this.sockets.get(addr) ?? []) {
        ws.send(this.encode({ type: "new_msg", data: this.listItem(message, addr) }));
      }
    }
  }

  private participants(m: StoredMessage): Set<string> {
    const set = new Set<string>([m.from, ...m.to]);
    for (const b of m.add_to) {
      set.add(b.add_to_from);
      for (const a of b.to) set.add(a);
    }
    return set;
  }

  private shortText(m: StoredMessage): string | undefined {
    if (!m.type.toLowerCase().startsWith("text/")) return undefined;
    const text = m.data.toString("utf8");
    if (Buffer.byteLength(text) <= this.shortTextBytes) return text;
    let cut = m.data.subarray(0, this.shortTextBytes).toString("utf8");
    if (cut.endsWith("�")) cut = cut.slice(0, -1);
    return cut;
  }

  private reactionsOf(m: StoredMessage): Array<{ emoji: string; from: string[] }> {
    const latest = new Map<string, { emoji: string; time: number }>();
    for (const r of this.messages.values()) {
      if (r.deleted || r.reaction === null || r.pid !== m.id || r.time === null) continue;
      const prev = latest.get(r.from);
      if (!prev || r.time > prev.time) latest.set(r.from, { emoji: r.reaction, time: r.time });
    }
    const groups = new Map<string, string[]>();
    for (const [from, { emoji }] of latest) {
      if (!emoji) continue;
      groups.set(emoji, [...(groups.get(emoji) ?? []), from]);
    }
    return [...groups].map(([emoji, from]) => ({ emoji, from }));
  }

  private body(m: StoredMessage, subject: string): Record<string, unknown> {
    const mine = m.from === subject;
    const timeRead = m.readBy.get(subject) ?? null;
    const short = this.shortText(m);
    return {
      version: m.version,
      has_pid: m.pid !== null,
      has_add_to: m.add_to.length > 0,
      important: m.important,
      no_reply: m.no_reply,
      deflate: false,
      terminal: m.terminal,
      pid: m.pid,
      from: m.from,
      to: m.to,
      to_delivery: m.to_delivery,
      add_to: m.add_to,
      time: m.time,
      topic: m.topic,
      type: m.type,
      size: m.data.byteLength,
      ...(short !== undefined ? { short_text: short } : {}),
      read: mine ? false : timeRead !== null,
      time_read: mine ? null : timeRead,
      attachments: m.attachments.map((a) => ({ size: a.size, filename: a.filename })),
      reaction: m.reaction,
      reactions: this.reactionsOf(m),
    };
  }

  private listItem(m: StoredMessage, subject: string): Record<string, unknown> {
    return { id: m.id, ...this.body(m, subject) };
  }

  private encode(value: unknown): string {
    return JSON.stringify(value).replace(ID_FIELDS, (_m, field: string, id: string) => `"${field}":${id}`);
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(this.encode(value));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const log: LoggedRequest = { method, path };
    this.requests.push(log);

    if (this.failNext && this.failNext.match.test(`${method} ${path}`)) {
      const f = this.failNext;
      this.failNext = undefined;
      await readBody(req);
      return this.json(res, f.status, { error: f.error, ...(f.code ? { code: f.code } : {}) });
    }

    if (method === "POST" && path === "/fmsg/token") {
      const key = req.headers.authorization?.replace(/^Bearer\s+/iu, "");
      const subject = key ? this.apiKeys.get(key) : undefined;
      if (!subject) return this.json(res, 401, { error: "invalid API key" });
      const exp = Math.floor(Date.now() / 1000) + this.tokenTtlSeconds;
      return this.json(res, 200, {
        access_token: jwt(subject, exp),
        token_type: "Bearer",
        expires_in: this.tokenTtlSeconds,
        expires_at: new Date(exp * 1000).toISOString(),
      });
    }

    const subject = subjectOf(req.headers.authorization?.replace(/^Bearer\s+/iu, ""));
    if (!subject) {
      await readBody(req);
      return this.json(res, 401, { error: "missing or invalid token" });
    }
    if (this.rejectNextProtected) {
      this.rejectNextProtected = false;
      await readBody(req);
      return this.json(res, 401, { error: "token expired" });
    }

    const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 20));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const byIdDesc = (a: StoredMessage, b: StoredMessage) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1);

    if (method === "GET" && path === "/fmsg") {
      const items = [...this.messages.values()]
        .filter((m) => !m.deleted && m.time !== null && m.from !== subject && (m.to.includes(subject) || m.add_to.some((b) => b.to.includes(subject))))
        .sort(byIdDesc)
        .slice(offset, offset + limit)
        .map((m) => this.listItem(m, subject));
      return this.json(res, 200, items);
    }
    if (method === "GET" && path === "/fmsg/sent") {
      const items = [...this.messages.values()]
        .filter((m) => !m.deleted && m.from === subject)
        .sort(byIdDesc)
        .slice(offset, offset + limit)
        .map((m) => this.listItem(m, subject));
      return this.json(res, 200, items);
    }
    if (method === "POST" && path === "/fmsg") {
      const raw = (await readBody(req)).toString("utf8");
      log.rawBody = raw;
      const input = JSON.parse(raw) as Record<string, unknown>;
      log.body = input;
      if (input.from !== subject) return this.json(res, 403, { error: "from does not match the authenticated address" });
      if (!Array.isArray(input.to) || input.to.length === 0) return this.json(res, 400, { error: "to is required" });
      let pid: string | null = null;
      if (input.pid !== undefined && input.pid !== null) {
        if (typeof input.pid !== "number") return this.json(res, 400, { error: "json: cannot unmarshal pid" });
        const pidStr = /"pid":\s*([0-9]+)/u.exec(raw)?.[1] ?? String(input.pid);
        const parent = this.messages.get(pidStr);
        if (!parent || parent.deleted) return this.json(res, 400, { error: `PID ${pidStr} not found` });
        if (parent.terminal) return this.json(res, 409, { error: `PID ${pidStr} is terminal; it cannot be replied to` });
        if (typeof input.topic === "string" && input.topic !== "") return this.json(res, 400, { error: "topic must be empty when pid is set" });
        pid = pidStr;
      }
      const m = this.seed({
        from: subject,
        to: input.to as string[],
        pid,
        topic: typeof input.topic === "string" ? input.topic : "",
        type: typeof input.type === "string" ? input.type : "",
        data: typeof input.data === "string" ? input.data : "",
        important: input.important === true,
        no_reply: input.no_reply === true,
        terminal: input.terminal === true,
        time: null,
      });
      return this.json(res, 201, { id: m.id });
    }

    const parts = path.split("/").filter(Boolean);
    if (parts[0] !== "fmsg" || !parts[1]) return this.json(res, 404, { error: "not found" });
    const id = parts[1];
    const m = this.messages.get(id);
    const visible = m && !m.deleted && this.participants(m).has(subject);
    if (!m || m.deleted || (!visible && !(m.from === subject))) {
      await readBody(req);
      return this.json(res, 404, { error: "message not found" });
    }
    const sub = parts[2];

    if (method === "GET" && !sub) return this.json(res, 200, this.body(m, subject));
    if (method === "DELETE" && !sub) {
      if (m.from !== subject) return this.json(res, 403, { error: "not the owner" });
      m.deleted = true;
      res.writeHead(204);
      return res.end();
    }
    if (method === "POST" && sub === "send") {
      if (m.from !== subject) return this.json(res, 403, { error: "not the owner" });
      if (m.time !== null) return this.json(res, 400, { error: "message already sent" });
      const problems: string[] = [];
      if (m.to.length === 0) problems.push("no recipients");
      if (!m.type) problems.push("no type");
      if (problems.length) return this.json(res, 400, { error: `message is not sendable: ${problems.join("; ")}` });
      m.time = this.now();
      m.to_delivery = m.to.map((addr) => ({ addr, time_delivered: new Date((m.time! + 1) * 1000).toISOString(), response_code: 200 }));
      this.push(m);
      return this.json(res, 200, { id: m.id, time: m.time });
    }
    if (method === "POST" && sub === "read") {
      if (!m.to.includes(subject) && !m.add_to.some((b) => b.to.includes(subject))) return this.json(res, 404, { error: "message not found" });
      const existing = m.readBy.get(subject);
      const t = existing ?? this.now();
      m.readBy.set(subject, t);
      return this.json(res, 200, { id: m.id, time_read: t });
    }
    if (method === "POST" && sub === "add-to") {
      const input = JSON.parse((await readBody(req)).toString("utf8")) as { add_to?: string[] };
      log.body = input;
      if (m.terminal) return this.json(res, 409, { error: "message is terminal; recipients cannot be added" });
      if (m.from !== subject && !m.to.includes(subject)) return this.json(res, 403, { error: "only the sender or a primary recipient may add recipients" });
      const add = input.add_to ?? [];
      const existing = this.participants(m);
      if (add.some((a) => existing.has(a))) return this.json(res, 400, { error: "recipient already added" });
      const t = this.now();
      m.add_to.push({ batch_id: String(this.nextId++), add_to_from: subject, to: add, to_delivery: add.map((addr) => ({ addr, time_delivered: new Date((t + 1) * 1000).toISOString(), response_code: 200 })), time: t });
      for (const addr of add) for (const ws of this.sockets.get(addr) ?? []) ws.send(this.encode({ type: "new_msg", data: this.listItem(m, addr) }));
      return this.json(res, 200, { id: m.id, added: add.length });
    }
    if (method === "POST" && sub === "react") {
      const input = JSON.parse((await readBody(req)).toString("utf8")) as { emoji?: string | null };
      log.body = input;
      if (m.time === null || m.terminal) return this.json(res, 409, { error: "cannot react to a draft or terminal message" });
      const emoji = typeof input.emoji === "string" ? input.emoji : "";
      if (Buffer.byteLength(emoji) > 64) return this.json(res, 400, { error: "not a single emoji" });
      const others = [...this.participants(m)].filter((a) => a !== subject);
      if (others.length === 0) return this.json(res, 409, { error: "no other participants" });
      const current = this.reactionsOf(m).find((g) => g.from.includes(subject))?.emoji ?? "";
      if (current === emoji) return this.json(res, 200, { id: null, time: null });
      const r = this.seed({ from: subject, to: others, pid: m.id, type: "text/plain;charset=UTF-8", data: emoji, reaction: emoji, no_reply: true, terminal: true });
      for (const addr of this.participants(m)) for (const ws of this.sockets.get(addr) ?? []) ws.send(this.encode({ type: "reaction", data: this.listItem(m, addr) }));
      return this.json(res, 201, { id: r.id, time: r.time });
    }
    if (method === "GET" && sub === "data") {
      res.writeHead(200, { "content-type": m.type || "application/octet-stream", "content-disposition": "attachment" });
      return res.end(m.data);
    }
    if (method === "POST" && sub === "attach") {
      if (m.from !== subject) return this.json(res, 403, { error: "not the owner" });
      if (m.time !== null) return this.json(res, 403, { error: "attachments cannot be added to a sent message" });
      const raw = await readBody(req);
      const form = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"] ?? "" }, body: new Uint8Array(raw) }).formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) return this.json(res, 400, { error: "file field is required" });
      let filename = (file as File).name || "upload.bin";
      const taken = new Set(m.attachments.map((a) => a.filename.toLowerCase()));
      if (taken.has(filename.toLowerCase())) {
        const dot = filename.lastIndexOf(".");
        const stem = dot > 0 ? filename.slice(0, dot) : filename;
        const ext = dot > 0 ? filename.slice(dot) : "";
        let n = 1;
        while (taken.has(`${stem}_${n}${ext}`.toLowerCase())) n++;
        filename = `${stem}_${n}${ext}`;
      }
      const data = Buffer.from(await file.arrayBuffer());
      m.attachments.push({ filename, size: data.byteLength, data, type: file.type || "application/octet-stream" });
      log.body = { filename, bytes: data.byteLength };
      return this.json(res, 201, { filename, size: data.byteLength });
    }
    if (sub === "attach" && parts[3]) {
      const name = decodeURIComponent(parts[3]);
      const idx = m.attachments.findIndex((a) => a.filename === name);
      if (idx < 0) return this.json(res, 404, { error: "attachment not found" });
      if (method === "GET") {
        const a = m.attachments[idx]!;
        res.writeHead(200, { "content-type": a.type, "content-length": String(a.size), "content-disposition": "attachment" });
        return res.end(a.data);
      }
      if (method === "DELETE") {
        if (m.time !== null) return this.json(res, 403, { error: "message already sent" });
        m.attachments.splice(idx, 1);
        res.writeHead(204);
        return res.end();
      }
    }
    if (method === "GET" && sub === "thread" && !parts[3]) {
      const chain = this.lineage(m);
      const text = chain
        .map((x) => {
          if (!this.participants(x).has(subject)) return "[message not visible to you]";
          const when = x.time === null ? "draft" : new Date(x.time * 1000).toISOString();
          const body = isText(x.type) ? x.data.toString("utf8") : `[non-text message: ${x.type}, ${x.data.byteLength} bytes]`;
          return `--- ${x.from} ${when} ---\n${body}`;
        })
        .join("\n\n");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(text);
    }
    if (method === "GET" && sub === "thread" && parts[3] === "messages") {
      if (this.threadTooDeep) return this.json(res, 422, { error: "thread too deep", code: "thread_too_deep" });
      const chain = this.lineage(m);
      let complete = true;
      const messages = chain.map((x) => {
        if (!this.participants(x).has(subject)) {
          complete = false;
          return { id: x.id, visible: false };
        }
        const inline = isText(x.type) && x.data.byteLength <= 65_536;
        return {
          id: x.id,
          visible: true,
          version: 1,
          pid: x.pid,
          from: x.from,
          to: x.to,
          add_to: x.add_to,
          time: x.time,
          topic: x.topic,
          type: x.type,
          size: x.data.byteLength,
          message_sha256: "00",
          body: {
            type: x.type,
            size: x.data.byteLength,
            ...(inline ? { text: x.data.toString("utf8") } : { download: `/fmsg/${x.id}/data` }),
            cacheable: false,
          },
          attachments: x.attachments.map((a, i) => ({ position: i, type: a.type, filename: a.filename, size: a.size, download: `/fmsg/${x.id}/attach/${encodeURIComponent(a.filename)}`, cacheable: false })),
        };
      });
      return this.json(res, 200, { root_id: chain[0]!.id, trigger_id: m.id, complete, messages });
    }
    await readBody(req);
    return this.json(res, 404, { error: "not found" });
  }

  private lineage(m: StoredMessage): StoredMessage[] {
    const chain: StoredMessage[] = [];
    let cur: StoredMessage | undefined = m;
    while (cur && chain.length < 200) {
      chain.push(cur);
      cur = cur.pid ? this.messages.get(cur.pid) : undefined;
    }
    return chain.reverse();
  }
}
