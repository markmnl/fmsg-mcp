import { createHash } from "node:crypto";
import { mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import { normalizeMessageId } from "../client/message-id.js";
import { messageData } from "../render.js";
import { idSchema, ok, type Register, withCaller } from "./common.js";

/** Produce one portable leaf name, even for unusual upstream filenames. */
function localName(id: string, filename: string): string {
  const simple = filename.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 180);
  const suffix = simple !== filename || simple.endsWith(".")
    ? `-${createHash("sha256").update(filename).digest("hex").slice(0, 12)}` : "";
  return `${id}-${simple}${suffix}`;
}

export const registerSaveTool: Register = (server, deps) => {
  const configuredDirectory = deps.config.downloadDir;
  if (deps.config.transport !== "stdio" || !configuredDirectory) return;
  server.registerTool("save_attachment", {
    title: "Save fmsg attachment",
    description: "Stream an attachment directly to the configured local download folder without putting file bytes in model context. " +
      "Creates a new file named from its message id and filename; never overwrites. No destination path is accepted. " +
      "Returns the saved path and byte count. Available only in stdio when a download folder is configured.",
    inputSchema: z.strictObject({ id: idSchema, filename: z.string().min(1).regex(/^[^/\\\u0000]+$/u, "use an attachment filename without directory components") }),
    outputSchema: z.object({ id: z.string(), filename: z.string(), saved_to: z.string(), size: z.number(), content_type: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ id, filename }, ctx) => withCaller(deps, ctx, async (caller, signal) => {
    const mid = normalizeMessageId(id);
    const { stream, contentType } = await caller.client.streamAttachment(mid, filename, signal);
    const reader = stream.getReader();
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let target: string | undefined;
    let complete = false;
    let size = 0;
    try {
      // The operator controls this directory and its ancestors. No subdirectory
      // or path supplied by the model is used, and wx refuses existing symlinks.
      await mkdir(configuredDirectory, { recursive: true, mode: 0o700 });
      const directory = await realpath(configuredDirectory);
      target = path.join(directory, localName(mid, filename));
      signal.throwIfAborted();
      file = await open(target, "wx", 0o600);
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.byteLength;) {
          signal.throwIfAborted();
          const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
          if (!bytesWritten) throw new Error("attachment file write made no progress");
          offset += bytesWritten;
        }
        size += value.byteLength;
      }
      await file.close();
      complete = true;
      return ok(`Saved attachment (${size} bytes).\n\n${messageData(`Filename: ${filename}\nSaved to: ${target}`)}`, {
        id: mid, filename, saved_to: target, size, content_type: contentType ?? "application/octet-stream",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("The attachment's generated destination already exists. Move or remove that file with your host's file tools before saving again.");
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      if (file) {
        await file.close().catch(() => undefined);
        if (!complete && target) await unlink(target).catch(() => undefined);
      }
    }
  }));
};
