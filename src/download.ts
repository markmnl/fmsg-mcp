import { normalizeMessageId } from "./client/message-id.js";
import type { Config } from "./config.js";

export const DOWNLOAD_PATH = "/mcp/attachments";

export function downloadBaseUrl(config: Config): string | undefined {
  return config.transport === "http" ? config.http.publicUrl ?? config.oauth?.resourceUrl : undefined;
}

export function attachmentFilename(filename: string): string {
  if (!filename || filename === "." || filename === ".." || /[/\\\x00-\x1f\x7f]/u.test(filename)) {
    throw new Error("use an attachment filename without directory components or control characters");
  }
  // Also reject unpaired UTF-16 surrogates before building a URL/header.
  encodeURIComponent(filename);
  return filename;
}

export function attachmentDownloadUrl(baseUrl: string, id: string, filename: string): string {
  return `${baseUrl.replace(/\/$/u, "")}/attachments/${normalizeMessageId(id)}/${encodeURIComponent(attachmentFilename(filename))}`;
}

export function parseDownloadPath(pathname: string): { id: string; filename: string } {
  const parts = pathname.slice(DOWNLOAD_PATH.length + 1).split("/");
  if (parts.length !== 2) throw new Error("invalid attachment download path");
  return { id: normalizeMessageId(parts[0]), filename: attachmentFilename(decodeURIComponent(parts[1]!)) };
}

/** Always download untrusted files; preserve Unicode filenames without raw header characters. */
export function downloadHeaders(filename: string, contentType?: string): Headers {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/gu, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/gu, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Headers({
    "content-type": contentType ?? "application/octet-stream",
    "content-disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
  });
}
