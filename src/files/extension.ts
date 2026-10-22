/**
 * The MCP file-uploads extension, io.modelcontextprotocol/files: the draft at
 * modelcontextprotocol/experimental-ext-file-uploads, branch localden/initial-draft at
 * 6101d34eb52b21d4b87028543ecd1fd59ed3d5df (after PR #2). See docs/files-extension-notes.md for the
 * choices this server makes where the draft is open.
 */
import { createHash } from "node:crypto";
import { CLIENT_CAPABILITIES_META_KEY, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { FilesConfig } from "../config.js";
import { FILENAME, decodeBase64Strict } from "../tools/attachments.js";

export const FILES_EXTENSION = "io.modelcontextprotocol/files";
export const UPLOAD_METHOD = "io.modelcontextprotocol/files/upload";
/** The key of the upload request in inputRequests and of its answer in inputResponses. */
export const UPLOADS_KEY = "uploads";
/** The draft this implementation follows. */
export const DRAFT_COMMIT = "6101d34eb52b21d4b87028543ecd1fd59ed3d5df";

/** The extension's settings advertised in server/discover capabilities. */
export function advertisedSettings(files: FilesConfig): { maxInlineBytes: number } {
  return { maxInlineBytes: files.maxInlineBytes };
}

const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/u;

/** A FileInput as a tool argument: the file's metadata, with its bytes inline in `data` or sent to an upload target. */
export function fileInputSchema(files: FilesConfig) {
  return z.object({
    id: z.string().min(1).max(128).describe("unique per file in this call"),
    name: z.string().max(255).optional().describe("the file's name; characters other than letters, digits, dot, underscore and hyphen become _"),
    mimeType: z.string().min(1).max(255).describe("media type; application/octet-stream if unknown"),
    size: z.number().int().nonnegative().describe("decoded size in bytes"),
    digest: z.object({
      algorithm: z.string().describe("sha-256"),
      value: z.string().describe("base64url SHA-256 of the file, without padding"),
    }),
    data: z.string().optional().describe("base64 file bytes; omit to upload the file to a target this server returns"),
  }).meta({ "x-mcp-file": { ...(files.maxFileBytes !== undefined ? { maxSize: files.maxFileBytes } : {}) } }).describe(
    `a file sent with the ${FILES_EXTENSION} extension, by clients that implement it; models give filename and data_base64 or data_text instead`,
  );
}

export type FileInput = z.infer<ReturnType<typeof fileInputSchema>>;

export function isFileInput(value: unknown): value is FileInput {
  return typeof value === "object" && value !== null && "id" in value && "digest" in value && "mimeType" in value;
}

/** The base64url (no padding) form of a hex SHA-256, as FileInput digests carry it. */
export function hexToBase64url(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64url");
}

export function base64urlToHex(value: string): string {
  return Buffer.from(value, "base64url").toString("hex");
}

/** Whether this request declared the extension in its per-request client capabilities. */
export function clientDeclaresFiles(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { extensions?: Record<string, unknown> } | undefined;
  const declared = capabilities?.extensions?.[FILES_EXTENSION];
  return typeof declared === "object" && declared !== null;
}

/** A FileInput whose metadata passed every check that does not need its bytes. */
export type CheckedFile = {
  id: string;
  /** The name it is attached under: FileInput.name made a valid fmsg attachment name. */
  filename: string;
  mimeType: string;
  size: number;
  /** Lowercase hex. */
  sha256: string;
  /** The verified bytes when the file came inline. */
  data?: Uint8Array;
};

/** A valid fmsg attachment name from a client-chosen file name; `fallback` when nothing usable is left. */
export function attachmentName(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? "").normalize("NFKD").replace(/[̀-ͯ]/gu, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^[._]+/u, "").slice(-200);
  return cleaned && FILENAME.test(cleaned) && !/^\.+$/u.test(cleaned) ? cleaned : fallback;
}

const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:\s*;[\x20-\x7e]*)?$/u;

/**
 * Check FileInputs before anything is created: unique ids, a valid digest and media type, sizes within the operator
 * limit, attachment names that do not collide (with each other or with `takenNames`), and inline data that matches
 * its size and digest within the inline budget. Throws an Error whose message names the file and the problem.
 */
export function checkFiles(inputs: FileInput[], files: FilesConfig, takenNames: string[]): CheckedFile[] {
  const ids = new Set<string>();
  const names = new Set(takenNames.map((n) => n.toLowerCase()));
  let inline = 0;
  return inputs.map((f, index) => {
    const label = `file ${JSON.stringify(f.id)}`;
    if (ids.has(f.id)) throw new Error(`${label}: id is used by more than one file in this call; each file needs its own id`);
    ids.add(f.id);
    if (f.digest.algorithm.toLowerCase() !== "sha-256") throw new Error(`${label}: digest algorithm must be sha-256, not ${JSON.stringify(f.digest.algorithm)}`);
    if (!BASE64URL_SHA256.test(f.digest.value)) throw new Error(`${label}: digest value must be the base64url SHA-256 without padding (43 characters)`);
    if (!MEDIA_TYPE.test(f.mimeType)) throw new Error(`${label}: mimeType ${JSON.stringify(f.mimeType)} is not a media type such as application/pdf`);
    if (files.maxFileBytes !== undefined && f.size > files.maxFileBytes) {
      throw new Error(`${label}: ${f.size} bytes is larger than this server's limit of ${files.maxFileBytes} bytes per file`);
    }
    const filename = attachmentName(f.name, `file-${index + 1}`);
    if (names.has(filename.toLowerCase())) {
      throw new Error(`${label}: another attachment in this call is already named ${filename}; give each file a different name`);
    }
    names.add(filename.toLowerCase());
    const sha256 = base64urlToHex(f.digest.value);
    const checked: CheckedFile = { id: f.id, filename, mimeType: f.mimeType, size: f.size, sha256 };
    if (f.data === undefined) return checked;
    let data: Buffer;
    try { data = f.data === "" ? Buffer.alloc(0) : decodeBase64Strict(filename, f.data); }
    catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message.replace(/^attachment \S+: /u, "") : String(error)}`); }
    inline += data.byteLength;
    if (inline > files.maxInlineBytes) {
      throw new Error(`${label}: inline data in this call totals more than this server's maxInlineBytes (${files.maxInlineBytes}); ` +
        "omit data to upload the file to a target instead");
    }
    if (data.byteLength !== f.size) throw new Error(`${label}: data decodes to ${data.byteLength} bytes but size is ${f.size}; nothing was sent`);
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== sha256) throw new Error(`${label}: data does not match its digest (got ${hexToBase64url(actual)}); nothing was sent`);
    return { ...checked, data: new Uint8Array(data) };
  });
}

/** Canonical JSON (sorted keys), so the same arguments always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function argumentsHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("base64url");
}
