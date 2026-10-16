import { normalizeMessageId } from "./client/message-id.js";
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
