import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import * as z from "zod/v4";
import type { FmsgClient } from "../client/client.js";
import type { Attachment, DraftInput, DraftResult } from "../client/types.js";
import type { Config } from "../config.js";
import { downloadBaseUrl } from "../download.js";
import { attachmentType } from "../render.js";

export const FILENAME = /^[A-Za-z0-9._-]+$/u;
const SHA256 = /^[0-9A-Fa-f]{64}$/u;

/** Ways this server can take a file without the model writing its bytes. */
export type FileRoutes = {
  /** create_draft returns an HTTP upload URL (HTTP with a public MCP URL). */
  uploadUrl: boolean;
  /** Attachments may name a file in FMSG_MCP_UPLOAD_DIR (stdio). */
  uploadFolder: boolean;
  /** get_attachment_upload_url issues single-use upload links that need no credentials (HTTP). */
  presigned: boolean;
  /** The MCP file-uploads extension is offered, for clients that implement it. */
  extension: boolean;
};

export function fileRoutes(config: Config, presigned = false): FileRoutes {
  const uploadUrl = Boolean(downloadBaseUrl(config));
  return { uploadUrl, uploadFolder: Boolean(config.uploadDir), presigned: uploadUrl && presigned, extension: Boolean(config.files) };
}

/** The routes for files too large for base64, in words for a model; empty when there are none. */
export function largeFileRoutes(routes: FileRoutes): string[] {
  return [
    ...(routes.uploadFolder ? ["path, a file in the upload folder"] : []),
    ...(routes.uploadUrl ? [`create_draft's upload URL${routes.presigned ? " (or a single-use link from get_attachment_upload_url)" : ""}`] : []),
    ...(routes.extension ? ["the MCP file-uploads extension, if your client implements it"] : []),
  ];
}

/** Inline base64 this long (about 48 KB of file) earns a hint about a better route next time. A hint only, never a limit. */
const BASE64_HINT_CHARS = 64 * 1024;

/** A hint for the model after it wrote a large file as base64 although this server offers a route that avoids it. */
export function base64Hint(items: AttachmentArgs[] | undefined, routes: FileRoutes): string | undefined {
  const large = (items ?? []).filter((a) => (a.data_base64?.length ?? 0) >= BASE64_HINT_CHARS).map((a) => a.filename);
  const better = [
    ...(routes.uploadUrl ? [`call create_draft, PUT them to its upload URL${routes.presigned ? " or to single-use links from get_attachment_upload_url" : ""}, then call send_draft`] : []),
    ...(routes.uploadFolder ? ["give their path in the upload folder instead of data_base64"] : []),
  ];
  if (!large.length || !better.length) return undefined;
  return `${large.join(", ")} went inline as base64. Next time, send files this large without writing their bytes: ${better.join(", or ")}.`;
}

/** The attachment sources this server accepts; `path` only over stdio with an upload folder. */
function sources(config: Config): string[] {
  return ["data_base64", "data_text", ...(config.uploadDir ? ["path"] : [])];
}

/** One outbound attachment as a tool argument: a filename and exactly one source of bytes. */
export function attachmentInput(config: Config, routes: FileRoutes = fileRoutes(config)) {
  const names = sources(config);
  const large = largeFileRoutes(routes);
  return z.strictObject({
    filename: z.string().regex(FILENAME, "letters, digits, dot, underscore, hyphen only").describe("file name"),
    data_base64: z.string().optional().describe("base64 file contents. You write the base64, so it is best effort: fine for " +
      `small files (checked exact up to 16 KB). Always give sha256 with it${large.length ? `. For anything larger use ${large.join(", or ")}` : ""}. ` +
      "The host sets the size limit"),
    data_text: z.string().optional().describe("text file contents, sent as UTF-8 bytes; use instead of data_base64 for text"),
    ...(config.uploadDir ? {
      path: z.string().min(1).optional().describe("file in the configured upload folder, relative to it; the server reads it so its bytes skip model context"),
    } : {}),
    content_type: z.string().optional().describe("inferred from the filename when omitted"),
    sha256: z.string().regex(SHA256, "64 hexadecimal characters").optional().describe(
      "hex sha256 of the file; the attachment is refused, and nothing sent, if the bytes differ. Always give it with data_base64",
    ),
  }).superRefine((a, ctx) => {
    const given = names.filter((name) => (a as Record<string, unknown>)[name] !== undefined);
    if (given.length !== 1) ctx.addIssue({ code: "custom", message: `attachment ${a.filename}: give exactly one of ${names.join(", ")}` });
  });
}

/** Parsed attachment arguments; `path` is a string whenever the schema registered it. */
export type AttachmentArgs = { filename: string; data_base64?: string; data_text?: string; path?: unknown; content_type?: string; sha256?: string };

/** A validated attachment ready to upload: bytes in memory, or a file to stream. */
export type PreparedAttachment = { filename: string; contentType: string; sha256?: string } & ({ data: Uint8Array } | { file: string });

/**
 * Decode base64 strictly: one alphabet (standard, or URL-safe with - and _) plus whitespace, `=` padding only at the
 * end, a valid length, and no stray trailing bits. Node's decoder skips anything else silently, which would send a
 * corrupted file.
 */
export function decodeBase64Strict(filename: string, input: string): Buffer {
  const bad = /[^A-Za-z0-9+/\-_=\s]/u.exec(input);
  if (bad) throw new Error(`attachment ${filename}: invalid base64 character ${JSON.stringify(bad[0])} at position ${bad.index}`);
  const standard = /[+/]/u.exec(input);
  const urlSafe = /[-_]/u.exec(input);
  if (standard && urlSafe) {
    const [first, second] = standard.index < urlSafe.index ? [standard, urlSafe] : [urlSafe, standard];
    throw new Error(`attachment ${filename}: base64 mixes the standard and URL-safe alphabets (${JSON.stringify(first[0])} at position ${first.index}, ` +
      `${JSON.stringify(second[0])} at position ${second.index}); part of the data may be corrupt`);
  }
  const compact = input.replace(/\s+/gu, "").replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = compact.indexOf("=");
  const unpadded = padding < 0 ? compact : compact.slice(0, padding);
  if ((padding >= 0 && (!/^={1,2}$/u.test(compact.slice(padding)) || compact.length % 4 !== 0)) || unpadded.length % 4 === 1) {
    throw new Error(`attachment ${filename}: invalid base64 length or padding; part of the data may be missing`);
  }
  const data = Buffer.from(compact, "base64");
  if (data.toString("base64").replace(/=+$/u, "") !== unpadded) throw new Error(`attachment ${filename}: invalid base64 ending; part of the data may be missing`);
  return data;
}

/** Resolve a path inside the operator's upload folder; refuse anything that leaves it, including through symlinks. */
async function uploadFile(directory: string, filename: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.includes("\0")) throw new Error(`attachment ${filename}: path must be relative to the upload folder`);
  const root = await realpath(directory);
  let target: string;
  try { target = await realpath(path.join(root, relative)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`attachment ${filename}: ${relative} was not found in the upload folder`);
    throw error;
  }
  const inside = path.relative(root, target);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`attachment ${filename}: path must stay inside the upload folder`);
  if (!(await stat(target)).isFile()) throw new Error(`attachment ${filename}: ${relative} is not a regular file`);
  return target;
}

function checksum(filename: string, expected: string | undefined, data: Uint8Array): void {
  if (!expected) return;
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected.toLowerCase()) throw new Error(`attachment ${filename}: sha256 mismatch (expected ${expected.toLowerCase()}, got ${actual}); nothing was sent`);
}

/** Validate every attachment before anything is created upstream, so a bad one never leaves a draft behind. */
export async function prepareAttachments(items: AttachmentArgs[] | undefined, config: Config): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = [];
  for (const a of items ?? []) {
    const sha256 = a.sha256?.toLowerCase();
    const base = { filename: a.filename, ...(sha256 ? { sha256 } : {}) };
    if (typeof a.path === "string") {
      if (!config.uploadDir) throw new Error(`attachment ${a.filename}: path needs an upload folder (FMSG_MCP_UPLOAD_DIR, stdio only)`);
      prepared.push({ ...base, contentType: a.content_type ?? attachmentType(a.filename), file: await uploadFile(config.uploadDir, a.filename, a.path) });
      continue;
    }
    const text = a.data_text !== undefined;
    const data = text ? Buffer.from(a.data_text!, "utf8") : decodeBase64Strict(a.filename, a.data_base64 ?? "");
    if (data.byteLength === 0) throw new Error(`attachment ${a.filename} is empty`);
    checksum(a.filename, sha256, data);
    const inferred = attachmentType(a.filename);
    const contentType = a.content_type ?? (text && inferred === "application/octet-stream" ? "text/plain; charset=utf-8" : inferred);
    prepared.push({ ...base, contentType, data: new Uint8Array(data) });
  }
  return prepared;
}

/** Upload prepared attachments into a draft; files stream from disk and are checked against their sha256. */
export async function uploadPrepared(client: FmsgClient, draftId: string, prepared: PreparedAttachment[], signal: AbortSignal): Promise<Attachment[]> {
  const uploaded: Attachment[] = [];
  for (const a of prepared) {
    if ("data" in a) {
      uploaded.push(await client.uploadAttachment(draftId, { filename: a.filename, data: a.data, contentType: a.contentType }, signal));
    } else {
      const stream = Readable.toWeb(createReadStream(a.file)) as ReadableStream<Uint8Array>;
      const { filename, size } = await client.uploadAttachmentStream(draftId, {
        filename: a.filename, stream, contentType: a.contentType, ...(a.sha256 ? { expectedSha256: a.sha256 } : {}),
      }, signal);
      uploaded.push({ filename, size });
    }
  }
  return uploaded;
}

/** Create a draft and upload its attachments, deleting the draft if any upload fails. */
export async function draftWithAttachments(client: FmsgClient, input: DraftInput, prepared: PreparedAttachment[], signal: AbortSignal): Promise<DraftResult & { attachments: Attachment[] }> {
  const draft = await client.createDraft({ ...input, signal });
  try {
    return { ...draft, attachments: await uploadPrepared(client, draft.id, prepared, signal) };
  } catch (error) {
    await client.deleteMessage(draft.id).catch(() => undefined);
    throw error;
  }
}

/** Draft, attach and send in one step; the draft is deleted if any step fails. */
export async function sendWithAttachments(client: FmsgClient, input: DraftInput, prepared: PreparedAttachment[], signal: AbortSignal) {
  const draft = await draftWithAttachments(client, input, prepared, signal);
  try {
    return { ...draft, ...(await client.sendDraft(draft.id, signal)) };
  } catch (error) {
    await client.deleteMessage(draft.id).catch(() => undefined);
    throw error;
  }
}
