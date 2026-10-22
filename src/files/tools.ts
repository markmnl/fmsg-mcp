/** What the send-type tools share to accept FileInputs next to their classic attachment arguments. */
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { DraftInput } from "../client/types.js";
import type { Caller } from "../context.js";
import { toolError } from "../errors.js";
import type { ToolResult } from "../tools/common.js";
import { attachmentType, sortAttachments } from "../render.js";
import { type AttachmentArgs, type PreparedAttachment, attachmentInput, fileRoutes, prepareAttachments } from "../tools/attachments.js";
import type { ToolDeps } from "../tools/common.js";
import { FILES_EXTENSION, type FileInput, fileInputSchema, isFileInput } from "./extension.js";
import { type FileCall, type Finish, checkInitialFiles, inlineAttachments, requestUploads, resumeUploads, splitAttachments } from "./flow.js";

/** The attachments argument: classic attachments, plus FileInputs when this server offers the extension. */
export function attachmentsArgument(deps: ToolDeps, description: string) {
  const classic = attachmentInput(deps.config, fileRoutes(deps.config, Boolean(deps.links)));
  const item = deps.files ? z.union([classic, fileInputSchema(deps.files.config)]) : classic;
  return z.array(item).optional().describe(deps.files
    ? `${description}. Clients implementing the ${FILES_EXTENSION} extension may give FileInputs instead`
    : description);
}

/** The attachments of a call, ready to draft: everything with bytes, and FileInputs still to be uploaded. */
export type PreparedCall =
  | { kind: "ready"; prepared: PreparedAttachment[]; classic: AttachmentArgs[]; types: Record<string, string> }
  | { kind: "uploads"; start: (input: DraftInput, summary: Record<string, unknown>) => Promise<ToolResult>; classic: AttachmentArgs[] };

export function fileCall(deps: ToolDeps, ctx: ServerContext, caller: Caller, signal: AbortSignal, tool: string, args: unknown): FileCall | undefined {
  return deps.files && { runtime: deps.files, ctx, caller, signal, tool, args };
}

/** A retry of a call that requested uploads, finished by `finish`; undefined when this call is not a retry. */
export function resumed(call: FileCall | undefined, finish: Finish): Promise<ToolResult> | undefined {
  return call && call.ctx.mcpReq.requestState() !== undefined ? resumeUploads(call, finish) : undefined;
}

/**
 * Validate a call's attachments before anything is created upstream. Returns an error result for refused FileInput
 * metadata; otherwise either everything ready to draft, or a starter that drafts and requests the missing uploads.
 */
export async function prepareCall(deps: ToolDeps, call: FileCall | undefined, items: Array<AttachmentArgs | FileInput> | undefined): Promise<PreparedCall | CallToolResult> {
  const { files: inputs, classic } = splitAttachments<AttachmentArgs>(items, isFileInput);
  const prepared = await prepareAttachments(classic, deps.config);
  if (!inputs.length) return { kind: "ready", prepared, classic, types: typesOf(prepared) };
  if (!call) return toolError("this server does not accept FileInputs; give filename with data_base64 or data_text");
  const checked = checkInitialFiles(call, inputs, prepared.map((a) => a.filename));
  if ("content" in checked) return checked;
  const all = [...prepared, ...inlineAttachments(checked)];
  const pending = checked.filter((f) => !f.data);
  const types = { ...typesOf(all), ...Object.fromEntries(pending.map((f) => [f.filename, f.mimeType])) };
  if (!pending.length) return { kind: "ready", prepared: all, classic, types };
  return { kind: "uploads", classic, start: (input, summary) => requestUploads(call, input, all, pending, { ...summary, types }) };
}

function typesOf(prepared: PreparedAttachment[]): Record<string, string> {
  return Object.fromEntries(prepared.map((a) => [a.filename, a.contentType]));
}

/** Attachments as a draft lists them, typed by what the call declared. */
export function typedAttachments(list: Array<{ filename: string; size: number }>, types: Record<string, string> = {}) {
  return sortAttachments(list.map((a) => ({ ...a, type: attachmentType(a.filename, types[a.filename]) })));
}
