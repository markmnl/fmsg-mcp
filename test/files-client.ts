/**
 * A minimal client for the MCP file-uploads extension (io.modelcontextprotocol/files), as the draft describes the
 * client side: declare the extension per request, call the tool with file metadata, check each upload target, PUT
 * the bytes, then retry with the same arguments, the echoed requestState and one outcome per file. It speaks
 * 2026-07-28 JSON-RPC over HTTPS directly, because the SDK client only fulfils the base protocol's input requests.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const FILES = "io.modelcontextprotocol/files";
const PROTOCOL = "2026-07-28";

export type FileInput = { id: string; name?: string; mimeType: string; size: number; digest: { algorithm: "sha-256"; value: string }; data?: string };
export type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
export type UploadTarget = { fileId: string; url: string; headers?: Record<string, string>; credentials: "omit" | "include" };
export type RpcResponse = { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };

export function digestOf(bytes: Uint8Array): { algorithm: "sha-256"; value: string } {
  return { algorithm: "sha-256", value: createHash("sha256").update(bytes).digest("base64url") };
}

/** FileInput metadata for `bytes`, inline when `inline` is set. */
export function fileInput(id: string, name: string, mimeType: string, bytes: Uint8Array, inline = false): FileInput {
  return { id, name, mimeType, size: bytes.byteLength, digest: digestOf(bytes), ...(inline ? { data: Buffer.from(bytes).toString("base64") } : {}) };
}

// Fetch's forbidden request headers, plus Authorization and Cookie (Upload targets rule 3).
const FORBIDDEN = new Set(["accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method", "connection",
  "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "referer", "set-cookie", "te", "trailer",
  "transfer-encoding", "upgrade", "via", "authorization"]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/** Whether an IP address is globally reachable; a simplified reading of the IANA special-purpose registries. */
function globallyReachable(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  const v6 = ip.toLowerCase();
  return !(v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:"));
}

export type ClientOptions = {
  /** The MCP server's canonical URI, which the client's credential was issued for. */
  mcpUrl: string;
  bearer: string;
  /** Trusted CA for the test certificate. */
  ca: string;
  /** Operator allowlist of addresses that are not globally reachable. */
  allowAddresses?: string[];
};

export class FilesClient {
  private nextId = 1;
  /** Every HTTP request this client made, for assertions. */
  readonly log: Array<{ method: string; url: string; status: number; authorization: boolean }> = [];

  constructor(readonly options: ClientOptions) {}

  async http(method: string, url: string, headers: Record<string, string>, body?: Uint8Array): Promise<HttpResult> {
    const target = new URL(url);
    if (target.protocol !== "https:") throw new Error(`refusing ${url}: not https`);
    return await new Promise<HttpResult>((resolve, reject) => {
      const req = httpsRequest(target, { method, headers, ca: this.options.ca }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          this.log.push({ method, url, status: res.statusCode ?? 0, authorization: "authorization" in headers || "Authorization" in headers });
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(body ? Buffer.from(body) : undefined);
    });
  }

  /** One JSON-RPC request in the 2026-07-28 shape, declaring the files extension unless `declare` is false. */
  async rpc(method: string, params: Record<string, unknown>, declare = true): Promise<RpcResponse> {
    const id = this.nextId++;
    const capabilities = declare ? { extensions: { [FILES]: {} } } : {};
    const payload = {
      jsonrpc: "2.0", id, method,
      params: { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "files-harness", version: "0.0.0" },
        "io.modelcontextprotocol/clientCapabilities": capabilities,
      } },
    };
    const res = await this.http("POST", this.options.mcpUrl, {
      accept: "application/json, text/event-stream", "content-type": "application/json", authorization: `Bearer ${this.options.bearer}`,
      "mcp-protocol-version": PROTOCOL, "mcp-method": method, ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    }, Buffer.from(JSON.stringify(payload)));
    const text = res.body.toString("utf8");
    const type = String(res.headers["content-type"] ?? "");
    if (type.startsWith("text/event-stream")) {
      const events = text.split(/\r?\n\r?\n/u).map((e) => e.split(/\r?\n/u).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")).filter(Boolean);
      const reply = events.map((e) => JSON.parse(e) as RpcResponse & { id?: number }).find((m) => m.id === id);
      if (!reply) throw new Error(`no response to request ${id}`);
      return reply;
    }
    if (!type.startsWith("application/json")) throw new Error(`unexpected response ${res.status} ${type}: ${text}`);
    return JSON.parse(text) as RpcResponse;
  }

  /** The extension's settings from server/discover; undefined when the server does not advertise it. */
  async discover(): Promise<{ maxInlineBytes?: number } | undefined> {
    const reply = await this.rpc("server/discover", {});
    const capabilities = reply.result?.capabilities as { extensions?: Record<string, { maxInlineBytes?: number }> } | undefined;
    return capabilities?.extensions?.[FILES];
  }

  /** Check a target against the draft's Upload targets rules; returns the headers to send, or why it is refused. */
  async checkTarget(target: UploadTarget): Promise<{ headers: Record<string, string> } | { refused: string }> {
    let url: URL;
    try { url = new URL(target.url); } catch { return { refused: "url is not absolute" }; }
    if (url.protocol !== "https:") return { refused: "url is not https" };
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    const address = isIP(host) ? host : (await lookup(host)).address;
    if (!globallyReachable(address) && !(this.options.allowAddresses ?? []).includes(address)) return { refused: `address ${address} is not globally reachable` };
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(target.headers ?? {})) {
      const lower = name.toLowerCase();
      if (!TOKEN.test(name) || FORBIDDEN.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) return { refused: `header ${name} is not allowed` };
      if (!/^[\t\x20-\x7e\x80-\xff]*$/u.test(value) || value !== value.trim()) return { refused: `header ${name} has an invalid value` };
      headers[name] = value;
    }
    if (target.credentials === "include") {
      const canonical = new URL(this.options.mcpUrl);
      const path = canonical.pathname.replace(/\/$/u, "");
      if (url.origin === canonical.origin && (url.pathname === path || url.pathname.startsWith(`${path}/`))) headers.authorization = `Bearer ${this.options.bearer}`;
      // Otherwise the target is treated as "omit": no credential.
    }
    return { headers };
  }

  /** PUT one file to its target, at most three attempts for retryable failures. */
  async transfer(target: UploadTarget, bytes: Uint8Array): Promise<{ ok: boolean; status?: number; reason?: string }> {
    const checked = await this.checkTarget(target);
    if ("refused" in checked) return { ok: false, reason: checked.refused };
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res: HttpResult;
      try { res = await this.http("PUT", target.url, checked.headers, bytes); }
      catch (error) { if (attempt === 3) return { ok: false, reason: String(error) }; continue; }
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt === 3) return { ok: false, status: res.status, reason: res.body.toString("utf8") };
    }
    return { ok: false };
  }

  /**
   * Call a tool with files: the initial call, the uploads it requests, and the retry, without returning to the model
   * in between. `bytes` gives each FileInput's content by id; `failUpload` makes the client report a file failed.
   */
  async callWithFiles(name: string, args: Record<string, unknown>, bytes: Record<string, Uint8Array>, options: { failUpload?: string[] } = {}) {
    const rounds: Array<{ targets: UploadTarget[]; outcomes: Array<{ fileId: string; status: string }> }> = [];
    let reply = await this.rpc("tools/call", { name, arguments: args });
    for (let round = 0; round < 3; round++) {
      const result = reply.result;
      if (!result || result.resultType !== "input_required") return { reply, rounds };
      const request = (result.inputRequests as Record<string, { method: string; params: { files: UploadTarget[] } }> | undefined)?.uploads;
      if (!request || request.method !== `${FILES}/upload`) throw new Error("input_required without an upload request");
      const outcomes: Array<{ fileId: string; status: string }> = [];
      for (const target of request.params.files) {
        const file = bytes[target.fileId];
        const done = file && !options.failUpload?.includes(target.fileId) ? await this.transfer(target, file) : { ok: false };
        outcomes.push({ fileId: target.fileId, status: done.ok ? "completed" : "failed" });
      }
      rounds.push({ targets: request.params.files, outcomes });
      reply = await this.rpc("tools/call", {
        name, arguments: args, requestState: result.requestState, inputResponses: { uploads: { resultType: "complete", files: outcomes } },
      });
    }
    return { reply, rounds };
  }
}
