/**
 * Files a host hands to a tool by reference (ChatGPT's `openai/fileParams`): the host fills a file object with a
 * download URL and the server fetches the bytes, so they never pass through the model and the model needs no
 * outbound HTTP of its own. The download only reaches public addresses: every hop is resolved, checked and connected
 * to by the checked address, so a hostile URL can't reach loopback, the local network or a cloud metadata service.
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import * as z from "zod/v4";
import { attachmentType } from "./render.js";

/** The input field the host fills, named in each tool's `_meta["openai/fileParams"]`. */
export const HOST_FILES_FIELD = "files";
export const HOST_FILE_META = { "openai/fileParams": [HOST_FILES_FIELD] };

/**
 * OpenAI's file object: the four properties declared, download_url and file_id required, the others optional.
 * Not strict, so an optional property the host adds later is accepted.
 */
export const hostFileSchema = z.object({
  download_url: z.string().describe("filled in by the host"),
  file_id: z.string().describe("filled in by the host"),
  mime_type: z.string().optional().describe("filled in by the host"),
  file_name: z.string().optional().describe("filled in by the host"),
}).describe("a file the user shared in this chat, filled in by the host");

export const hostFilesInput = z.array(hostFileSchema).optional().describe(
  "files the user shared in this chat (images, PDFs and so on); the host fills these in and this server downloads them, " +
  "so never write their bytes as base64",
);

export type HostFileArgs = { download_url: string; file_id: string; mime_type?: string; file_name?: string };

/** A downloaded host file, ready to attach. */
export type HostFile = { fileId: string; filename: string; contentType: string; data: Uint8Array; sha256: string };

/** One HTTP response from a download hop. */
export type HostResponse = { status: number; headers: Record<string, string | undefined>; body: AsyncIterable<Uint8Array>; cancel: () => void };
/** Fetches one URL with no redirects followed; tests substitute it. */
export type HostTransport = (url: URL, signal: AbortSignal) => Promise<HostResponse>;

export type HostFileOptions = {
  /** Byte limit per file. */
  maxBytes: number;
  /** Allowed host names (exact or a parent domain); empty allows any public host. */
  allowedHosts: string[];
  transport?: HostTransport;
  /** Per-file time budget. */
  timeoutMs?: number;
};

export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FILENAME_MAX = 100;

// Addresses a download must never reach.
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, bits, "ipv6");

/** Whether an IP address is public (globally routable), so a download may connect to it. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  if (family === 4) return !blocked.check(address, "ipv4");
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1) and NAT64 (64:ff9b::/96) addresses are judged by their IPv4 address.
  const embedded = embeddedIpv4(address);
  if (embedded) return !blocked.check(embedded, "ipv4");
  return !blocked.check(address, "ipv6");
}

/** The IPv4 address inside an IPv4-mapped or NAT64 IPv6 address, if it is one. */
function embeddedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  const prefix = ["::ffff:", "64:ff9b::"].find((p) => lower.startsWith(p));
  if (!prefix) return undefined;
  const rest = lower.slice(prefix.length);
  if (isIP(rest) === 4) return rest;
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(rest);
  if (!m) return undefined;
  const hi = parseInt(m[1]!, 16), lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

class RefusedError extends Error {}

/** A DNS lookup for https.request that only ever yields public addresses: the connection uses what was checked. */
function publicLookup(hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const ok = addresses.filter((a) => isPublicAddress(a.address));
    if (!ok.length) return callback(Object.assign(new RefusedError("address not public"), { code: "EREFUSED_PRIVATE" }), "", 0);
    if ((options as { all?: boolean }).all) return callback(null, ok);
    callback(null, ok[0]!.address, ok[0]!.family);
  });
}

/** The default transport: HTTPS to public addresses only, nothing followed. */
export const publicHttpsTransport: HostTransport = (url, signal) => new Promise((resolve, reject) => {
  if (isIP(url.hostname.replace(/^\[|\]$/gu, "")) && !isPublicAddress(url.hostname.replace(/^\[|\]$/gu, ""))) {
    reject(new RefusedError("address not public"));
    return;
  }
  const req = httpsRequest(url, { method: "GET", lookup: publicLookup as never, signal, headers: { accept: "*/*" } }, (res) => {
    resolve({
      status: res.statusCode ?? 0,
      headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])),
      body: res,
      cancel: () => res.destroy(),
    });
  });
  req.on("error", (error: NodeJS.ErrnoException) => reject(error.code === "EREFUSED_PRIVATE" ? new RefusedError("address not public") : error));
  req.end();
});

function hostAllowed(host: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const h = host.toLowerCase();
  return allowed.some((a) => { const d = a.toLowerCase().replace(/^\./u, ""); return h === d || h.endsWith(`.${d}`); });
}

function checkUrl(raw: string, allowed: string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RefusedError("not a valid URL"); }
  if (url.protocol !== "https:") throw new RefusedError("only https download URLs are accepted");
  if (url.username || url.password) throw new RefusedError("credentials in the URL are not accepted");
  if (!hostAllowed(url.hostname, allowed)) throw new RefusedError(`host ${url.hostname} is not an allowed file host`);
  return url;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "image/svg+xml": "svg",
  "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "application/json": "json",
  "application/zip": "zip", "audio/mpeg": "mp3", "audio/mp4": "m4a", "video/mp4": "mp4", "video/quicktime": "mov",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** A safe attachment name (letters, digits, dot, underscore, hyphen) from what the host gave. */
export function hostFilename(given: string | undefined, contentType: string | undefined): string {
  const base = (given ?? "").split(/[\\/]/u).pop() ?? "";
  let name = base.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/_+/gu, "_").replace(/^[._]+/u, "");
  if (name.length > FILENAME_MAX) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, FILENAME_MAX - ext.length) + ext;
  }
  if (!name || name === "_") {
    const ext = EXTENSIONS[(contentType ?? "").split(";")[0]!.trim().toLowerCase()];
    name = ext ? `file.${ext}` : "file";
  }
  return name;
}

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate.toLowerCase())) { taken.add(candidate.toLowerCase()); return candidate; }
  }
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

/** Download one host file: public HTTPS, redirects checked, size-limited, hashed. */
async function download(file: HostFileArgs, label: string, options: HostFileOptions, outer: AbortSignal): Promise<{ data: Uint8Array; sha256: string; contentType?: string }> {
  const transport = options.transport ?? publicHttpsTransport;
  const signal = AbortSignal.any([outer, AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
  let url: URL;
  try { url = checkUrl(file.download_url, options.allowedHosts); }
  catch (error) { throw new Error(`file ${label}: download refused (${(error as Error).message})`); }
  for (let hop = 0; ; hop++) {
    let res: HostResponse;
    try { res = await transport(url, signal); }
    catch (error) {
      if (error instanceof RefusedError) throw new Error(`file ${label}: download refused (${error.message})`);
      if (signal.aborted) throw new Error(`file ${label}: download timed out or was cancelled`);
      throw new Error(`file ${label}: download failed (${(error as Error).message})`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      res.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error(`file ${label}: download refused (too many redirects)`);
      try { url = checkUrl(new URL(res.headers.location, url).toString(), options.allowedHosts); }
      catch (error) { throw new Error(`file ${label}: download refused (${(error as Error).message})`); }
      continue;
    }
    if (res.status !== 200) { res.cancel(); throw new Error(`file ${label}: download failed: HTTP ${res.status}`); }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      res.cancel();
      throw new Error(`file ${label} is larger than ${sizeText(options.maxBytes)}`);
    }
    const hash = createHash("sha256");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > options.maxBytes) { res.cancel(); throw new Error(`file ${label} is larger than ${sizeText(options.maxBytes)}`); }
        hash.update(chunk);
        chunks.push(chunk);
      }
    } catch (error) {
      if ((error as Error).message.startsWith(`file ${label}`)) throw error;
      throw new Error(`file ${label}: download failed (${signal.aborted ? "timed out or was cancelled" : (error as Error).message})`);
    }
    if (total === 0) throw new Error(`file ${label} is empty`);
    const data = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { data.set(c, offset); offset += c.byteLength; }
    const contentType = res.headers["content-type"]?.split(",")[0]?.trim();
    return { data, sha256: hash.digest("hex"), ...(contentType ? { contentType } : {}) };
  }
}

/**
 * Download every host file before anything is created upstream, so a bad one never leaves a draft behind.
 * `taken` holds the names already used by the call's other attachments.
 */
export async function prepareHostFiles(files: HostFileArgs[] | undefined, options: HostFileOptions, signal: AbortSignal, taken: Set<string> = new Set()): Promise<HostFile[]> {
  const out: HostFile[] = [];
  for (const f of files ?? []) {
    if (!f.download_url || !f.file_id) throw new Error("each file needs download_url and file_id (the host fills them in)");
    const label = hostFilename(f.file_name, f.mime_type);
    const got = await download(f, label, options, signal);
    const contentType = f.mime_type?.trim() || got.contentType || attachmentType(label);
    const filename = uniqueName(f.file_name ? label : hostFilename(undefined, contentType), taken);
    out.push({ fileId: f.file_id, filename, contentType, data: got.data, sha256: got.sha256 });
  }
  return out;
}
