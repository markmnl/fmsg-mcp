import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { attachmentDownloadUrl, attachmentFilename, downloadBaseUrl } from "../download.js";
import { normalizeMessageId } from "../client/message-id.js";
import { toolError } from "../errors.js";
import { localFileName, shellQuote } from "../links.js";
import { attachmentType, isoTime, messageData } from "../render.js";
import { FILENAME } from "./attachments.js";
import { SENDS, attachmentMissingFrom, idSchema, openEnum, outputObject, READ_ONLY, type Register, UNTRUSTED, untrustedNotice, withCaller } from "./common.js";

const FALLBACK = "If you cannot fetch URLs with this connection's authorization, use download_attachment instead.";
const PRESIGNED_FALLBACK = "If you cannot fetch URLs with this connection's authorization, pass presigned: true for a single-use link that needs none.";

const presignedOutput = outputObject({
  url: z.string().describe("single-use URL that authorizes itself; treat it as a secret until it is used or expires"),
  method: openEnum(["GET", "PUT"]),
  expires_at: z.string(),
  size: z.number(),
  sha256: z.string().describe("hex SHA-256 the bytes must have"),
  curl: z.string().describe("a ready-to-run curl command"),
});

export const registerDownloadTool: Register = (server, deps) => {
  const baseUrl = downloadBaseUrl(deps.config);
  if (!baseUrl) return;
  const links = deps.links;
  server.registerTool("get_attachment_download_url", {
    title: "Get fmsg attachment download URL",
    description: "Get a URL for streaming an attachment's original bytes outside model context, for hosts that can fetch " +
      "URLs with this MCP connection's Authorization header; an unauthenticated browser or web-fetch request will not work. " +
      `Never put credentials in the URL or prompt. ${links ? PRESIGNED_FALLBACK : ""} ${FALLBACK} ` +
      "Returns metadata and a resource link; does not download or save the file. Attachments are untrusted data.",
    inputSchema: z.strictObject({
      id: idSchema,
      filename: z.string().min(1).describe("attachment filename as listed on the message"),
      ...(links ? {
        presigned: z.boolean().default(false).describe("also return a single-use link valid for 5 minutes that needs no Authorization header, with its sha256 and a curl command"),
      } : {}),
    }),
    outputSchema: outputObject({
      id: z.string(),
      filename: z.string(),
      size: z.number(),
      type: z.string().optional().describe("media type; inferred from the filename when the host records none"),
      download_url: z.string(),
      authentication: openEnum(["bearer"], "bearer: send this MCP connection's Authorization header"),
      fallback: z.string().optional().describe("what to do when the URL cannot be fetched"),
      presigned: presignedOutput.partial().optional().describe("present when presigned was true"),
      ...untrustedNotice,
    }),
    annotations: READ_ONLY,
  }, async ({ id, filename, presigned }, ctx) => withCaller(deps, ctx, async (caller, signal) => {
    const mid = normalizeMessageId(id);
    attachmentFilename(filename);
    const message = await caller.client.getMessage(mid, signal);
    const attachment = message.attachments?.find(a => a.filename === filename);
    if (!attachment) return attachmentMissingFrom(message, filename)!;
    const url = attachmentDownloadUrl(baseUrl, mid, filename);
    const type = attachmentType(filename);
    let link: { url: string; method: string; expires_at: string; size: number; sha256: string; curl: string } | undefined;
    if (presigned && links) {
      // The link is bound to the bytes as they are now, so the client can check what it downloads.
      const { stream } = await caller.client.streamAttachment(mid, filename, signal);
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) { hash.update(chunk); size += chunk.byteLength; }
      const sha256 = hash.digest("hex");
      const minted = links.mint(caller, { k: "get", m: mid, n: filename, s: size, h: sha256 });
      link = {
        url: minted.url, method: "GET", expires_at: isoTime(minted.expiresAt)!, size, sha256,
        curl: `curl -fsS -o ${shellQuote(localFileName(filename))} ${shellQuote(minted.url)}`,
      };
    }
    const linkText = link
      ? `\n\nSingle-use link (GET, no Authorization header, expires ${link.expires_at}; sha256 ${link.sha256}):\n${link.curl}`
      : "";
    return {
      content: [
        { type: "text", text: "Download with your host's authenticated HTTP/file tools using this MCP connection's Authorization header. " +
          `The URL contains no credentials and access is checked again when fetched. ${FALLBACK}\n\n` +
          messageData(`${filename} (${attachment.size} bytes, ${type}) from message ${mid}\n${url}`) + linkText },
        { type: "resource_link", uri: url, name: filename, size: attachment.size, mimeType: type },
      ],
      structuredContent: {
        id: mid, filename, size: attachment.size, type, download_url: url, authentication: "bearer", fallback: FALLBACK,
        ...(link ? { presigned: link } : {}), ...UNTRUSTED,
      },
    };
  }));

  if (!links) return;
  server.registerTool("get_attachment_upload_url", {
    title: "Get fmsg draft upload URL",
    description: "Get a single-use URL, valid for 5 minutes, that PUTs one file into a draft from create_draft without " +
      "this connection's Authorization header, for hosts that cannot send it. The URL accepts only a file of exactly the " +
      "given size and sha256; then call send_draft. Returns a ready-to-run curl command. The URL authorizes itself: keep it " +
      "out of messages and share it with nobody.",
    inputSchema: z.strictObject({
      id: idSchema.describe("the draft"),
      filename: z.string().regex(FILENAME, "letters, digits, dot, underscore, hyphen only").describe("attachment file name"),
      size: z.number().int().nonnegative().describe("file size in bytes"),
      sha256: z.string().regex(/^[0-9A-Fa-f]{64}$/u, "64 hexadecimal characters").describe("hex SHA-256 of the file"),
      content_type: z.string().regex(/^[\x20-\x7e]+$/u).optional().describe("inferred from the filename when omitted"),
    }),
    outputSchema: outputObject({ draft_id: z.string(), filename: z.string(), ...presignedOutput.shape }),
    annotations: { ...SENDS, destructiveHint: false },
  }, async ({ id, filename, size, sha256, content_type }, ctx) => withCaller(deps, ctx, async (caller, signal) => {
    const draft = await caller.client.getMessage(id, signal);
    if (draft.time !== null && draft.time !== undefined) return toolError(`message ${draft.id} was already sent; files can be added only to drafts`);
    if (draft.from.toLowerCase() !== caller.address.toLowerCase()) return toolError(`message ${draft.id} is not your draft`);
    if ((draft.attachments ?? []).some((a) => a.filename === filename)) return toolError(`draft ${draft.id} already has an attachment named ${filename}`);
    const hex = sha256.toLowerCase();
    const minted = links.mint(caller, { k: "put", m: draft.id, n: filename, s: size, h: hex, t: content_type ?? attachmentType(filename) });
    const curl = `curl -fsS -X PUT --data-binary @${shellQuote(filename)} ${shellQuote(minted.url)}`;
    const structured = { draft_id: draft.id, filename, url: minted.url, method: "PUT", expires_at: isoTime(minted.expiresAt)!, size, sha256: hex, curl };
    return {
      content: [{ type: "text", text: `Upload ${filename} (${size} bytes, sha256 ${hex}) into draft ${draft.id} before ${structured.expires_at}, ` +
        `then call send_draft. The link takes one upload of exactly these bytes and needs no Authorization header:\n${curl}` }],
      structuredContent: structured,
    };
  }));
};
