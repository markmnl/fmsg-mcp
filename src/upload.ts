import { AttachmentChecksumError } from "./client/client.js";
import { normalizeMessageId } from "./client/message-id.js";
import type { Caller } from "./context.js";
import { FILENAME } from "./tools/attachments.js";

export const UPLOAD_PATH = "/mcp/drafts";
/** Content-Encoding values accepted on uploads; decoded before the bytes reach fmsg. */
export const UPLOAD_ENCODINGS = ["gzip", "deflate"] as const;
export const CHECKSUM_HEADER = "x-content-sha256";

/** The PUT target for one draft's attachments, with `{filename}` left for the host to fill in. */
export function draftUploadUrlTemplate(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/$/u, "")}/drafts/${normalizeMessageId(id)}/attachments/{filename}`;
}

export function parseUploadPath(pathname: string): { id: string; filename: string } {
  const parts = pathname.slice(UPLOAD_PATH.length + 1).split("/");
  if (parts.length !== 3 || parts[1] !== "attachments") throw new Error("invalid attachment upload path");
  const filename = decodeURIComponent(parts[2]!);
  if (!FILENAME.test(filename) || /^\.+$/u.test(filename)) throw new Error("invalid attachment upload filename");
  return { id: normalizeMessageId(parts[0]), filename };
}

/** The upload request's own body was unusable (such as invalid compressed data); answered with 400. */
export class UploadBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadBodyError";
  }
}

/** How long draining a failed upload's remaining body may wait for more data before the connection is closed. */
export const UPLOAD_DRAIN_IDLE_MS = 10_000;

/**
 * The upload body as a stream whose cancellation leaves the request open, plus `drain()`, which discards what the
 * upload did not read so the answer can follow. drain() resolves false if the client goes idle first.
 */
export function drainableBody(body: ReadableStream<Uint8Array>, idleMs: number): { stream: ReadableStream<Uint8Array>; drain: () => Promise<boolean> } {
  const reader = body.getReader();
  let stopped = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (stopped) return;
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel: () => { stopped = true; },
  });
  const drain = async () => {
    stopped = true;
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<"idle">((resolve) => { timer = setTimeout(() => resolve("idle"), idleMs); });
      const next = await Promise.race([reader.read().catch(() => ({ done: true as const })), idle]);
      clearTimeout(timer);
      if (next === "idle") return false;
      if (next.done) return true;
    }
  };
  return { stream, drain };
}

/** Decode a Content-Encoding while streaming, reporting corrupt data as UploadBodyError. */
export function decodedUploadBody(body: ReadableStream<Uint8Array>, encoding: string | undefined): ReadableStream<Uint8Array> {
  if (!encoding) return body;
  const reader = body.pipeThrough(new DecompressionStream(encoding as CompressionFormat) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (error) {
        const code = (error as { code?: string } | undefined)?.code;
        const detail = code === "Z_BUF_ERROR" ? "the data ends early" : error instanceof Error ? error.message || code : String(error);
        throw new UploadBodyError(`the ${encoding} request body is invalid or truncated${detail ? ` (${detail})` : ""}`);
      }
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** The upload's Content-Encoding, lowercased; "identity" or none means undecoded. Throws for an unsupported one. */
export function uploadEncoding(header: string | null): string | undefined {
  const value = header?.trim().toLowerCase();
  if (!value || value === "identity") return undefined;
  if (!(UPLOAD_ENCODINGS as readonly string[]).includes(value)) throw new Error(`unsupported Content-Encoding ${JSON.stringify(header)}; use ${UPLOAD_ENCODINGS.join(" or ")}, or none`);
  return value;
}

// ── Uploads bound to one file's size and SHA-256 (presigned links) ──

const refuse = (status: number, error: string): Response => Response.json({ error }, { status });

/** The body as a stream that fails unless it is exactly `size` bytes. */
function exactly(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let read = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (read !== size) throw new SizeError(400, `the upload ended after ${read} bytes, but the file's declared size is ${size} bytes; it was not kept`);
        controller.close();
        return;
      }
      read += chunk.value.byteLength;
      if (read > size) throw new SizeError(413, `the upload is larger than the file's declared size of ${size} bytes; it was not kept`);
      controller.enqueue(chunk.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

class SizeError extends UploadBodyError {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Who keeps track of uploads to one kind of link: one at a time per file, and which were verified. */
export type UploadTracker = {
  begin(key: string): boolean;
  end(key: string): void;
  recordVerified(key: string, sha256: string): void;
  verifiedSha256(key: string): string | undefined;
};

/** One file a link accepts: into which draft, under which name, and exactly which bytes. */
export type UploadSlot = { draft: string; filename: string; size: number; sha256: string; mimeType: string; fileId?: string };

/**
 * Stream one upload into a draft, refusing any body that is not exactly the slot's size and SHA-256, and a second
 * upload after one succeeded. `noun` names the link in messages ("target", "link").
 */
export async function streamIntoDraft(
  tracker: UploadTracker, caller: Caller, slot: UploadSlot, request: Request, encoding: string | undefined, signal: AbortSignal, noun: string,
): Promise<Response> {
  const declared = request.headers.get("content-length");
  if (!encoding && declared !== null && Number(declared) !== slot.size) {
    return refuse(Number(declared) > slot.size ? 413 : 400, `Content-Length is ${declared}, but the file's declared size is ${slot.size} bytes`);
  }
  const key = `${slot.draft}/${slot.filename}`;
  if (tracker.verifiedSha256(key)) return refuse(409, `this upload ${noun} was already used; each ${noun} takes one upload`);
  if (!tracker.begin(key)) return refuse(409, `an upload to this ${noun} is already in progress`);
  const { stream, drain } = drainableBody(request.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }), UPLOAD_DRAIN_IDLE_MS);
  try {
    // The draft is the record of what arrived, also for uploads another instance took (shared key).
    const draft = await caller.client.getMessage(slot.draft, signal);
    if (draft.time !== null && draft.time !== undefined) {
      await drain();
      return refuse(409, `the draft this upload ${noun} belongs to was already sent`);
    }
    if ((draft.attachments ?? []).some((a) => a.filename === slot.filename)) {
      await drain();
      return refuse(409, `this upload ${noun} was already used; each ${noun} takes one upload`);
    }
    const body = exactly(decodedUploadBody(stream, encoding), slot.size);
    const uploaded = await caller.client.uploadAttachmentStream(slot.draft, { filename: slot.filename, stream: body, contentType: slot.mimeType, expectedSha256: slot.sha256 }, signal);
    tracker.recordVerified(key, uploaded.sha256);
    return Response.json({ ...(slot.fileId !== undefined ? { fileId: slot.fileId } : {}), filename: uploaded.filename, size: uploaded.size, sha256: uploaded.sha256 }, { status: 201 });
  } catch (error) {
    const drained = await drain();
    if (error instanceof SizeError) return refuse(error.status, error.message);
    if (error instanceof AttachmentChecksumError) {
      // A FileInput (fileId) declares its digest as base64url; other uploads give hex.
      const shown = (hex: string) => slot.fileId !== undefined ? Buffer.from(hex, "hex").toString("base64url") : hex;
      return refuse(422, `the uploaded bytes do not match the ${slot.fileId !== undefined ? "file's declared digest" : "declared sha256"} ${shown(slot.sha256)} ` +
        `(got ${shown(error.actual)}); it was not kept`);
    }
    if (!drained) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { undrained: true });
    throw error;
  } finally {
    tracker.end(key);
  }
}
