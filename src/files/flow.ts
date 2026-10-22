/**
 * The file-uploads flow for send_message, reply and create_draft.
 *
 * Initial call: every check that needs no bytes, then the fmsg draft is created as the staging location and inline
 * files are attached. If any file came without data, the call answers input_required with one upload target per
 * such file; the targets stream into that draft.
 *
 * Retry (same arguments, requestState, per-file outcomes): the outcomes are checked, each completed file is
 * confirmed in the draft against its declared size and digest, and only then does the tool finish (send the draft,
 * or return it for create_draft).
 */
import { createHash } from "node:crypto";
import { type CallToolResult, type ServerContext, inputRequired } from "@modelcontextprotocol/server";
import { FmsgHttpError } from "../client/client.js";
import type { Attachment, DraftInput, FmsgMessage } from "../client/types.js";
import type { Caller } from "../context.js";
import { toolError } from "../errors.js";
import type { ToolResult } from "../tools/common.js";
import { isoTime } from "../render.js";
import { type PreparedAttachment, draftWithAttachments } from "../tools/attachments.js";
import { type CheckedFile, type FileInput, UPLOADS_KEY, argumentsHash, checkFiles, clientDeclaresFiles, hexToBase64url } from "./extension.js";
import type { FilesRuntime, PendingFile, RoundState } from "./runtime.js";

/** How a tool finishes once every file is in its draft: `draft` is the draft as the host now lists it. */
export type Finish = (draft: FmsgMessage, summary: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>;

export type FileCall = {
  runtime: FilesRuntime;
  ctx: ServerContext;
  caller: Caller;
  signal: AbortSignal;
  tool: string;
  /** The tool's arguments as parsed; the retry must repeat them exactly. */
  args: unknown;
};

/** Split a tool's attachment arguments into the classic ones and FileInputs. */
export function splitAttachments<T extends object>(items: Array<T | FileInput> | undefined, isFile: (item: T | FileInput) => item is FileInput) {
  const files: FileInput[] = [];
  const classic: T[] = [];
  for (const item of items ?? []) {
    if (isFile(item)) files.push(item);
    else classic.push(item as T);
  }
  return { files, classic };
}

/** Inline FileInputs as attachments to upload with the draft. */
export function inlineAttachments(files: CheckedFile[]): PreparedAttachment[] {
  return files.filter((f) => f.data).map((f) => ({ filename: f.filename, contentType: f.mimeType, sha256: f.sha256, data: f.data! }));
}

/**
 * Check FileInputs for an initial call. Returns the checked files, or an error result when the metadata is refused
 * or when files without data cannot be uploaded on this request.
 */
export function checkInitialFiles(call: FileCall, inputs: FileInput[], classicNames: string[]): CheckedFile[] | CallToolResult {
  let files: CheckedFile[];
  try { files = checkFiles(inputs, call.runtime.config, classicNames); }
  catch (error) { return toolError(`${error instanceof Error ? error.message : String(error)}. Nothing was sent.`); }
  const pending = files.filter((f) => !f.data);
  if (pending.length && !clientDeclaresFiles(call.ctx)) {
    return toolError(`${pending.map((f) => JSON.stringify(f.id)).join(", ")} ${pending.length === 1 ? "has" : "have"} no data, and this request ` +
      "did not declare the io.modelcontextprotocol/files extension, so no upload target can be issued. Include the file's data, " +
      "or send it as filename with data_base64 or data_text. Nothing was sent.");
  }
  return files;
}

/**
 * Create the draft with `inline` attachments and request uploads for `pending` files. The draft is deleted again if
 * the request cannot be issued.
 */
export async function requestUploads(call: FileCall, input: DraftInput, inline: PreparedAttachment[], pending: CheckedFile[], summary: Record<string, unknown>): Promise<ToolResult> {
  const { runtime, caller, signal } = call;
  const draft = await draftWithAttachments(caller.client, input, inline, signal);
  try {
    const { round, exp } = runtime.newRound(caller, draft.id);
    const files: PendingFile[] = pending.map((f) => ({ id: f.id, filename: f.filename, size: f.size, sha256: f.sha256, mimeType: f.mimeType }));
    const state: RoundState = {
      v: 1, tool: call.tool, args: argumentsHash(call.args), address: caller.address.toLowerCase(), draft: draft.id, round, exp, files,
      summary: { ...summary, redactions: draft.redactions, redacted: draft.redacted },
    };
    const requestState = await runtime.codec.mint(state, call.ctx);
    if (!runtime.offer(requestState, runtime.uploadRequest(state))) throw new Error("this transport cannot deliver upload requests; send the files inline");
    return inputRequired({ requestState });
  } catch (error) {
    await caller.client.deleteMessage(draft.id).catch(() => undefined);
    throw error;
  }
}

type Outcome = { fileId: string; status: "completed" | "failed" };

/** The upload outcomes in a retry, or a description of what is wrong with them. */
function readOutcomes(ctx: ServerContext, state: RoundState): { outcomes: Outcome[] } | { missing: string[] } | { problem: string } {
  if (ctx.mcpReq.droppedInputResponseKeys?.includes(UPLOADS_KEY)) {
    return { problem: `inputResponses.${UPLOADS_KEY} must be the bare answer {resultType, files}, not wrapped in {method, result}` };
  }
  const answer = ctx.mcpReq.inputResponses?.[UPLOADS_KEY] as { resultType?: unknown; files?: unknown } | undefined;
  if (answer === undefined) return { missing: state.files.map((f) => f.id) };
  if (answer.resultType !== "complete") return { problem: `inputResponses.${UPLOADS_KEY}.resultType must be "complete"` };
  if (!Array.isArray(answer.files)) return { problem: `inputResponses.${UPLOADS_KEY}.files must be an array of {fileId, status}` };
  const expected = new Set(state.files.map((f) => f.id));
  const seen = new Set<string>();
  const outcomes: Outcome[] = [];
  for (const item of answer.files as Array<{ fileId?: unknown; status?: unknown }>) {
    const id = item?.fileId;
    if (typeof id !== "string") return { problem: "every upload outcome needs a fileId" };
    if (!expected.has(id)) return { problem: `upload outcome for unknown file ${JSON.stringify(id)}; this call requested uploads for ${[...expected].map((x) => JSON.stringify(x)).join(", ")}` };
    if (seen.has(id)) return { problem: `more than one upload outcome for file ${JSON.stringify(id)}` };
    if (item.status !== "completed" && item.status !== "failed") {
      return { problem: `upload outcome for file ${JSON.stringify(id)} has status ${JSON.stringify(item.status)}; use "completed" or "failed"` };
    }
    seen.add(id);
    outcomes.push({ fileId: id, status: item.status });
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  return missing.length ? { missing } : { outcomes };
}

/** Delete a call's draft if it is still an unsent draft. */
async function discardDraft(caller: Caller, id: string): Promise<void> {
  const draft = await caller.client.getMessage(id).catch(() => undefined);
  if (draft && (draft.time === null || draft.time === undefined)) await caller.client.deleteMessage(id).catch(() => undefined);
}

/** The SHA-256 of an attachment already in the draft, read back from the host. */
async function storedSha256(caller: Caller, draft: string, filename: string, size: number, signal: AbortSignal): Promise<string> {
  const { stream } = await caller.client.streamAttachment(draft, filename, signal);
  const hash = createHash("sha256");
  let read = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    read += chunk.byteLength;
    if (read > size) break;
    hash.update(chunk);
  }
  return read === size ? hash.digest("hex") : "";
}

/**
 * Handle a retry. `requestState` was verified by the SDK seam (codec MAC, expiry and principal binding) before this
 * runs; a state that fails there never reaches the tool and is answered with JSON-RPC -32602.
 */
export async function resumeUploads(call: FileCall, finish: Finish): Promise<ToolResult> {
  const { runtime, ctx, caller, signal, tool } = call;
  const state = ctx.mcpReq.requestState<RoundState>();
  if (!state || typeof state !== "object" || state.v !== 1) return toolError("requestState is not one this server issued for file uploads. Call the tool again without it.");
  if (state.tool !== tool) return toolError(`this requestState was issued by ${state.tool}, not ${tool}. Retry ${state.tool} with it, or call ${tool} again without it.`);
  if (state.address !== caller.address.toLowerCase()) return toolError("this requestState was issued to another fmsg address.");
  if (state.args !== argumentsHash(call.args)) {
    return toolError(`the arguments differ from the ${tool} call that requested these uploads. Retry with exactly the same arguments, ` +
      "or call the tool again without requestState to start over. Nothing was sent.");
  }
  const known = runtime.status(state.round);
  if (known?.status === "done") return toolError(`this ${tool} call already completed (${known.outcome ?? "done"}); a repeated retry does not run it again.`);
  if (known?.status === "running") return toolError(`this ${tool} call is already being completed by another retry; it does not run twice.`);
  if (known?.status === "ended") return toolError(`this ${tool} call already ended: ${known.outcome ?? "it failed"}. Call ${tool} again without requestState to start over.`);
  if (state.exp * 1000 <= Date.now()) {
    runtime.mark(state.round, "ended", "its upload targets expired", caller, state.draft);
    await discardDraft(caller, state.draft);
    return toolError(`the upload targets for this ${tool} call expired at ${isoTime(state.exp)}, so its draft was discarded and nothing was sent. ` +
      `Call ${tool} again without requestState to get new targets.`);
  }

  const read = readOutcomes(ctx, state);
  if ("problem" in read) return toolError(`${read.problem}. Nothing was sent; the upload targets stay valid until ${isoTime(state.exp)}.`);
  if ("missing" in read) {
    // An unanswered upload is unresolved: ask for it again, with the same targets, rather than run the tool.
    const requestState = await runtime.codec.mint(state, ctx);
    if (!runtime.offer(requestState, runtime.uploadRequest(state))) {
      return toolError(`no upload outcome was given for ${read.missing.map((x) => JSON.stringify(x)).join(", ")}; include one for every file.`);
    }
    return inputRequired({ requestState });
  }
  const failed = read.outcomes.filter((o) => o.status === "failed").map((o) => o.fileId);
  if (failed.length) {
    runtime.mark(state.round, "ended", `the client could not upload ${failed.join(", ")}`, caller, state.draft);
    await discardDraft(caller, state.draft);
    return toolError(`the client reported that ${failed.map((x) => JSON.stringify(x)).join(", ")} could not be uploaded, so this ${tool} call ` +
      "ended and nothing was sent. Call the tool again to retry.");
  }

  if (!runtime.mark(state.round, "running", undefined, caller, state.draft)) {
    return toolError(`this ${tool} call is already being completed by another retry; it does not run twice.`);
  }
  let finished = false;
  try {
    let draft: FmsgMessage;
    try { draft = await caller.client.getMessage(state.draft, signal); }
    catch (error) {
      if (error instanceof FmsgHttpError && error.status === 404) {
        runtime.mark(state.round, "ended", "its draft no longer exists");
        finished = true;
        return toolError(`the draft this ${tool} call was staging its files in (${state.draft}) no longer exists, so nothing was sent. Call ${tool} again without requestState.`);
      }
      throw error;
    }
    if (draft.time !== null && draft.time !== undefined) {
      runtime.mark(state.round, "done", `message ${draft.id} was sent`);
      finished = true;
      return toolError(`this ${tool} call already completed: message ${draft.id} was sent. A repeated retry does not send it again.`);
    }
    const attachments: Attachment[] = draft.attachments ?? [];
    const notArrived = state.files.filter((f) => !attachments.some((a) => a.filename === f.filename));
    if (notArrived.length) {
      // An early retry: keep the call open so the client can still upload and retry before the targets expire.
      runtime.mark(state.round, "open");
      finished = true;
      return toolError(`${notArrived.map((f) => JSON.stringify(f.id)).join(", ")} ${notArrived.length === 1 ? "was" : "were"} reported completed, ` +
        `but this server has not received ${notArrived.length === 1 ? "its" : "their"} bytes. PUT each file to its upload target first, then ` +
        `retry with the same requestState before ${isoTime(state.exp)}. Nothing was sent.`);
    }
    for (const f of state.files) {
      const stored = attachments.find((a) => a.filename === f.filename)!;
      const sha256 = stored.size === f.size
        ? runtime.verifiedSha256(`${state.draft}/${f.filename}`) ?? await storedSha256(caller, state.draft, f.filename, f.size, signal)
        : "";
      if (sha256 !== f.sha256) {
        runtime.mark(state.round, "ended", `${f.id} did not match its declared size and digest`);
        finished = true;
        await discardDraft(caller, state.draft);
        return toolError(`file ${JSON.stringify(f.id)} in the draft does not match its declared size (${f.size} bytes) and digest ` +
          `(${hexToBase64url(f.sha256)}), so this ${tool} call ended and nothing was sent. Call the tool again to retry.`);
      }
    }
    let result: CallToolResult;
    try { result = await finish(draft, state.summary, signal); }
    catch (error) {
      // Like a call without uploads, a failed send deletes its draft.
      runtime.mark(state.round, "ended", "it failed");
      finished = true;
      await discardDraft(caller, state.draft);
      throw error;
    }
    const outcome = (result.structuredContent as { id?: string; draft_id?: string } | undefined);
    runtime.mark(state.round, "done", outcome?.draft_id ? `draft ${outcome.draft_id} was created` : outcome?.id ? `message ${outcome.id} was sent` : undefined);
    finished = true;
    return result;
  } finally {
    // A failure while confirming the files (such as the host being unreachable) leaves the call open to retry.
    if (!finished) runtime.mark(state.round, "open");
  }
}
