/** What the send-type tools share to accept FileInputs next to their classic attachment arguments. */
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { DraftInput } from "../client/types.js";
import type { Caller } from "../context.js";
import { toolError } from "../errors.js";
import type { ToolResult } from "../tools/common.js";
import { attachmentType, sortAttachments } from "../render.js";
import type { HostFileArgs } from "../host-files.js";
import { type AttachmentArgs, type HostFileResult, type PreparedAttachment, attachmentInput, fileRoutes, hostFilesResult, prepareAllAttachments } from "../tools/attachments.js";
import type { ToolDeps } from "../tools/common.js";
import { FILES_EXTENSION, type FileInput, fileInputSchema, isFileInput } from "./extension.js";
import { type FileCall, type Finish, checkInitialFiles, inlineAttachments, requestUploads, resumeUploads, splitAttachments } from "./flow.js";

/** The attachments argument: classic attachments, plus FileInputs when this server offers the extension. */
export function attachmentsArgument(deps: ToolDeps, description: string) {
  const classic = attachmentInput(deps.config, fileRoutes(deps.config, Boolean(deps.links)));
  const offered = deps.files?.listsFileInputs() ? deps.files : undefined;
  const item = offered ? z.union([classic, fileInputSchema(offered.config)]) : classic;
  return z.array(item).optional().describe(offered
    ? `${description}. Clients implementing the ${FILES_EXTENSION} extension may give FileInputs instead`
    : description);
}

/** The attachments of a call, ready to draft: everything with bytes, and FileInputs still to be uploaded. */
export type PreparedCall = { classic: AttachmentArgs[]; hostFiles: HostFileResult[] } & (
  | { kind: "ready"; prepared: PreparedAttachment[]; types: Record<string, string> }
  | { kind: "uploads"; start: (input: DraftInput, summary: Record<string, unknown>) => Promise<ToolResult> }
);

/** Whether prepareCall gave attachments to go on with, rather than a result to return. */
export function isPrepared(value: PreparedCall | ToolResult): value is PreparedCall {
  return (value as { kind?: unknown }).kind === "ready" || (value as { kind?: unknown }).kind === "uploads";
}

export function fileCall(deps: ToolDeps, ctx: ServerContext, caller: Caller, signal: AbortSignal, tool: string, args: unknown): FileCall | undefined {
  return deps.files && { runtime: deps.files, ctx, caller, signal, tool, args };
}

/** A retry of a call that requested uploads, finished by `finish`; undefined when this call is not a retry. */
export function resumed(call: FileCall | undefined, finish: Finish): Promise<ToolResult> | undefined {
  return call && call.ctx.mcpReq.requestState() !== undefined ? resumeUploads(call, finish) : undefined;
}

/**
 * Validate a call's attachments before anything is created upstream. Returns an error result for refused FileInput
 * metadata (a tool error, or -32021 through the runtime); otherwise either everything ready to draft, or a starter
 * that drafts and requests the missing uploads. Callers tell them apart by `kind`.
 */
export async function prepareCall(
  deps: ToolDeps, call: FileCall | undefined, items: Array<AttachmentArgs | FileInput> | undefined, hostFileArgs: HostFileArgs[] | undefined, signal: AbortSignal,
): Promise<PreparedCall | ToolResult> {
  const { files: inputs, classic } = splitAttachments<AttachmentArgs>(items, isFileInput);
  const { prepared, hostFiles: fetched } = await prepareAllAttachments(classic, hostFileArgs, deps.config, deps.hostTransport, signal);
  const hostFiles = hostFilesResult(fetched);
  if (!inputs.length) return { kind: "ready", prepared, classic, hostFiles, types: typesOf(prepared) };
  if (!call) return toolError("this server does not accept FileInputs; give filename with data_base64 or data_text");
  const checked = checkInitialFiles(call, inputs, prepared.map((a) => a.filename));
  if (!Array.isArray(checked)) return checked;
  const all = [...prepared, ...inlineAttachments(checked)];
  const pending = checked.filter((f) => !f.data);
  const types = { ...typesOf(all), ...Object.fromEntries(pending.map((f) => [f.filename, f.mimeType])) };
  if (!pending.length) return { kind: "ready", prepared: all, classic, hostFiles, types };
  return { kind: "uploads", classic, hostFiles, start: (input, summary) => requestUploads(call, input, all, pending, { ...summary, types }) };
}

function typesOf(prepared: PreparedAttachment[]): Record<string, string> {
  return Object.fromEntries(prepared.map((a) => [a.filename, a.contentType]));
}

/** Attachments as a draft lists them, typed by what the call declared. */
export function typedAttachments(list: Array<{ filename: string; size: number }>, types: Record<string, string> = {}) {
  return sortAttachments(list.map((a) => ({ ...a, type: attachmentType(a.filename, types[a.filename]) })));
}
