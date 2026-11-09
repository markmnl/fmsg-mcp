/**
 * A minimal client for the MCP file-uploads extension (io.modelcontextprotocol/files), as the spec describes the
 * client side: declare the extension per request, call the tool with file metadata, check each upload target, PUT
 * the bytes, then retry with the same arguments and the echoed requestState. It speaks 2026-07-28 JSON-RPC over
 * HTTPS directly, because the SDK client does not implement the upload_required result type.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const FILES = "io.modelcontextprotocol/files";
const PROTOCOL = "2026-07-28";

export type FileInput = { id: string; name?: string; mimeType: string; size: number; digest?: { algorithm: "sha-256"; value: string }; data?: string };
export type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
export type UploadTarget = {
  fileId: string; url?: string; path?: string; method?: string; headers?: Record<string, string>; credentials: "omit" | "include"; expiresAt?: string;
  [extra: string]: unknown;
};
export type RpcResponse = { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };

export function digestOf(bytes: Uint8Array): { algorithm: "sha-256"; value: string } {
  return { algorithm: "sha-256", value: createHash("sha256").update(bytes).digest("base64url") };
}

/** FileInput metadata for `bytes`, with a digest, inline when `inline` is set. */
export function fileInput(id: string, name: string, mimeType: string, bytes: Uint8Array, inline = false): FileInput {
  return { id, name, mimeType, size: bytes.byteLength, digest: digestOf(bytes), ...(inline ? { data: Buffer.from(bytes).toString("base64") } : {}) };
}

// Fetch's forbidden request headers, plus Authorization and Cookie (Targets rule 3).
const FORBIDDEN = new Set(["accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method", "connection",
  "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "referer", "set-cookie", "te", "trailer",
  "transfer-encoding", "upgrade", "via", "authorization"]);
// Targets rule 4: refused on a path target or with credentials "include".
const ROUTING = new Set(["forwarded", "x-original-url", "x-rewrite-url", "x-http-method-override", "x-http-method", "x-method-override"]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const TARGET_KEYS = new Set(["fileId", "url", "path", "method", "form", "headers", "credentials", "expiresAt", "_meta"]);
const PATH = /^(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9\-_~.]+)+$/u;

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
  /** The MCP address, which is also the server's canonical URI here. */
  mcpUrl: string;
  bearer: string;
  /** Trusted CA for the test certificate. */
  ca: string;
  /** Operator allowlist of addresses that are not globally reachable, for url targets. */
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

  /**
   * One JSON-RPC request in the 2026-07-28 shape. `settings` are the extension settings declared; `null` declares
   * nothing.
   */
  async rpc(method: string, params: Record<string, unknown>, settings: Record<string, unknown> | null = { upload: {} }): Promise<RpcResponse & { status: number }> {
    const id = this.nextId++;
    const capabilities = settings ? { extensions: { [FILES]: settings } } : {};
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
      return { ...reply, status: res.status };
    }
    if (!type.startsWith("application/json")) throw new Error(`unexpected response ${res.status} ${type}: ${text}`);
    return { ...(JSON.parse(text) as RpcResponse), status: res.status };
  }

  /** The extension's settings from server/discover; undefined when the server does not advertise it. */
  async discover(): Promise<Record<string, unknown> | undefined> {
    const reply = await this.rpc("server/discover", {});
    const capabilities = reply.result?.capabilities as { extensions?: Record<string, Record<string, unknown>> } | undefined;
    return capabilities?.extensions?.[FILES];
  }

  /** A path target resolved against the MCP address: appended to its path, before any query string. */
  resolve(target: UploadTarget): string {
    if (target.url) return target.url;
    const base = new URL(this.options.mcpUrl);
    base.pathname = `${base.pathname.replace(/\/$/u, "")}${target.path}`;
    return base.toString();
  }

  /** Check a target against the spec's Targets rules; returns the URL and headers to send, or why it is refused. */
  async checkTarget(target: UploadTarget): Promise<{ url: string; headers: Record<string, string> } | { refused: string }> {
    // Rule 1: the type, exactly one of url and path, and no unknown members.
    if ((target.url === undefined) === (target.path === undefined)) return { refused: "needs exactly one of url and path" };
    const unknown = Object.keys(target).filter((k) => !TARGET_KEYS.has(k));
    if (unknown.length) return { refused: `unknown member ${unknown[0]}` };
    if (target.credentials !== "omit" && target.credentials !== "include") return { refused: "credentials must be omit or include" };
    if (target.method !== undefined && target.method !== "PUT" && target.method !== "POST") return { refused: "method must be PUT or POST" };
    if (target.form !== undefined) return { refused: "form targets are not implemented by this harness" };
    // Rule 2.
    let url: URL;
    if (target.path !== undefined) {
      if (!PATH.test(target.path)) return { refused: "path is not 1*( \"/\" segment )" };
      url = new URL(this.resolve(target));
    } else {
      try { url = new URL(target.url!); } catch { return { refused: "url is not absolute" }; }
      if (url.protocol !== "https:") return { refused: "url is not https" };
      if (url.username || url.password) return { refused: "url has userinfo" };
      const host = url.hostname.replace(/^\[|\]$/gu, "");
      const address = isIP(host) ? host : (await lookup(host)).address;
      if (!globallyReachable(address) && !(this.options.allowAddresses ?? []).includes(address)) return { refused: `address ${address} is not globally reachable` };
    }
    // Rules 3 and 4.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(target.headers ?? {})) {
      const lower = name.toLowerCase();
      if (!TOKEN.test(name) || FORBIDDEN.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) return { refused: `header ${name} is not allowed` };
      if ((target.path !== undefined || target.credentials === "include") && (ROUTING.has(lower) || lower.startsWith("x-forwarded-"))) {
        return { refused: `header ${name} is not allowed on this target` };
      }
      if (!/^[\t\x20-\x7e\x80-\xff]*$/u.test(value) || value !== value.trim()) return { refused: `header ${name} has an invalid value` };
      headers[name] = value;
    }
    if (target.credentials === "include") {
      // Only on a path target, or a url at the canonical URI's origin.
      if (target.url !== undefined && url.origin !== new URL(this.options.mcpUrl).origin) return { refused: "include target at another origin" };
      headers.authorization = `Bearer ${this.options.bearer}`;
    }
    return { url: url.toString(), headers };
  }

  /** PUT one file to its target, repeating a failed PUT at most twice. */
  async transfer(target: UploadTarget, bytes: Uint8Array): Promise<{ ok: boolean; status?: number; reason?: string }> {
    const checked = await this.checkTarget(target);
    if ("refused" in checked) return { ok: false, reason: checked.refused };
    if ((target.method ?? "PUT") !== "PUT") return { ok: false, reason: "only PUT is implemented by this harness" };
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res: HttpResult;
      try { res = await this.http("PUT", checked.url, checked.headers, bytes); }
      catch (error) { if (attempt === 3) return { ok: false, reason: String(error) }; continue; }
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, reason: "redirect" };
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt === 3) return { ok: false, status: res.status, reason: res.body.toString("utf8") };
    }
    return { ok: false };
  }

  /**
   * Call a tool with files: the initial call, the uploads it requests, and the retry, without returning to the model
   * in between. `bytes` gives the content of each file sent out of band, by id; `failUpload` makes a transfer fail. A failed transfer,
   * or a second upload request, fails the call without a retry.
   */
  async callWithFiles(name: string, args: Record<string, unknown>, bytes: Record<string, Uint8Array>, options: { failUpload?: string[] } = {}) {
    const first = await this.rpc("tools/call", { name, arguments: args });
    const result = first.result;
    if (!result || result.resultType !== "upload_required") return { reply: first, targets: [] as UploadTarget[] };
    const targets = result.uploads as UploadTarget[];
    const wanted = Object.entries(bytes).filter(([, b]) => b.byteLength > 0).map(([id]) => id);
    const ids = new Set(targets.map((t) => t.fileId));
    if (targets.length !== ids.size || ids.size !== wanted.length || targets.some((t) => !wanted.includes(t.fileId))) {
      return { failed: "the upload request does not list each file once", targets };
    }
    for (const target of targets) {
      const done = options.failUpload?.includes(target.fileId) ? { ok: false, reason: "failed on purpose" } : await this.transfer(target, bytes[target.fileId]!);
      if (!done.ok) return { failed: `${target.fileId}: ${done.reason ?? done.status}`, targets };
    }
    const reply = await this.rpc("tools/call", { name, arguments: args, requestState: result.requestState });
    if (reply.result?.resultType === "upload_required") return { failed: "a second upload request", targets };
    return { reply, targets };
  }
}
