/**
 * Presigned links: short-lived, single-use URLs that carry their own authorization, for hosts that cannot send this
 * MCP connection's Authorization header with their HTTP requests. A link is a signed capability for exactly one
 * transfer: GET one attachment, or PUT one file of a declared size and SHA-256 into one draft. It never contains
 * an API key or access token. The caller it acts for is kept in this process, so a link works only on the instance
 * that issued it.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Caller } from "./context.js";
import type { UploadTracker } from "./upload.js";

export const LINK_PATH = "/mcp/links";
/** How long a presigned link stays usable. */
export const LINK_TTL_SECONDS = 300;

/** What a link allows, signed into it. */
export type LinkClaims = {
  v: 1;
  /** GET downloads an attachment; PUT uploads one file into a draft. */
  k: "get" | "put";
  /** Link id, for single use. */
  j: string;
  /** The fmsg address it acts for. */
  a: string;
  /** Message id (GET) or draft id (PUT). */
  m: string;
  /** Attachment name. */
  n: string;
  /** Size in bytes. */
  s: number;
  /** SHA-256, lowercase hex. */
  h: string;
  /** Media type (PUT). */
  t?: string;
  /** Expiry, unix seconds. */
  e: number;
};

type Issued = { caller: Caller; used: boolean; expires: number };

export class PresignedLinks implements UploadTracker {
  private readonly key: Buffer;
  private readonly issued = new Map<string, Issued>();
  private readonly uploading = new Set<string>();
  private readonly verified = new Map<string, string>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly publicUrl: string, secret: string | undefined, private readonly ttlSeconds = LINK_TTL_SECONDS) {
    this.key = secret ? Buffer.from(secret, "utf8") : randomBytes(32);
    this.sweeper = setInterval(() => this.sweep(), 60_000).unref();
  }

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(`fmsg-mcp.presigned-link.v1:${body}`).digest("base64url");
  }

  /** Issue a link for `caller`. */
  mint(caller: Caller, claims: Omit<LinkClaims, "v" | "j" | "a" | "e">): { url: string; expiresAt: number } {
    const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const full: LinkClaims = { v: 1, j: randomUUID(), a: caller.address, e: expiresAt, ...claims };
    const body = Buffer.from(JSON.stringify(full)).toString("base64url");
    this.issued.set(full.j, { caller, used: false, expires: expiresAt * 1000 });
    return { url: `${this.publicUrl.replace(/\/$/u, "")}/links/${body}.${this.sign(body)}`, expiresAt };
  }

  /** The link in a request path, with the caller it acts for, or the status and reason to refuse it with. */
  resolve(token: string, method: string, now = Date.now()): { claims: LinkClaims; caller: Caller } | { status: number; error: string } {
    const [body, mac, extra] = token.split(".");
    const unknown = { status: 404, error: "unknown link" };
    if (!body || !mac || extra !== undefined) return unknown;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return unknown;
    let claims: LinkClaims;
    try { claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LinkClaims; }
    catch { return unknown; }
    if (claims.v !== 1) return unknown;
    if ((claims.k === "get") !== (method === "GET")) return { status: 405, error: claims.k === "get" ? "this link is for GET" : "this link is for PUT" };
    if (claims.e * 1000 <= now) return { status: 410, error: `this link expired at ${new Date(claims.e * 1000).toISOString()}; ask for a new one` };
    const issued = this.issued.get(claims.j);
    // Signed by this key but not issued here: another instance (shared key) or before a restart.
    if (!issued) return { status: 404, error: "this link was issued by another server instance or before a restart; ask for a new one" };
    if (claims.k === "get" && issued.used) return { status: 409, error: "this link was already used; each link downloads once" };
    return { claims, caller: issued.caller };
  }

  /** Spend a download link. False when it was already spent. */
  consume(id: string): boolean {
    const issued = this.issued.get(id);
    if (!issued || issued.used) return false;
    issued.used = true;
    return true;
  }

  // UploadTracker: a PUT link takes one successful upload; failed attempts leave it usable until it expires.
  begin(key: string): boolean { if (this.uploading.has(key)) return false; this.uploading.add(key); return true; }
  end(key: string): void { this.uploading.delete(key); }
  recordVerified(key: string, sha256: string): void { this.verified.set(key, sha256); }
  verifiedSha256(key: string): string | undefined { return this.verified.get(key); }

  private sweep(): void {
    const now = Date.now();
    for (const [id, issued] of this.issued) if (issued.expires <= now) this.issued.delete(id);
    if (!this.issued.size) this.verified.clear();
  }

  close(): void {
    clearInterval(this.sweeper);
    this.issued.clear();
    this.verified.clear();
  }
}

/** A string as one POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/** A local file name for curl -o: the attachment's name reduced to portable characters. */
export function localFileName(filename: string): string {
  const name = filename.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^[.-]+/u, "");
  return name || "attachment";
}
