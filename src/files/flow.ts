/**
 * The file-uploads flow for send_message, reply and create_draft.
 *
 * Initial call: every check that needs no bytes, then the fmsg draft is created as the staging location and inline
 * files are attached. If any non-empty file came without data, the call answers upload_required with one target per
 * such file; the targets stream into that draft.
 *
 * Retry (same arguments and requestState): the server checks the state against the call, confirms each file in the
 * draft against its declared size (and digest, if given), and only then finishes the tool: it sends the draft, or
 * returns it for create_draft. A retry states that every upload succeeded, so a file that is not there ends the call.
 */
import { createHash } from "node:crypto";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { FmsgHttpError } from "../client/client.js";
import type { DraftInput, FmsgMessage } from "../client/types.js";
import type { Caller } from "../context.js";
import { toolError } from "../errors.js";
import type { ToolResult } from "../tools/common.js";
import { type PreparedAttachment, draftWithAttachments } from "../tools/attachments.js";
import { type CheckedFile, type FileInput, argumentsHash, checkFiles, declaresUpload, hexToBase64url } from "./extension.js";
import type { FilesRuntime, PendingFile, RoundState } from "./runtime.js";

/** How a tool finishes once every file is in its draft: `draft` is the draft as the host now lists it. */
export type Finish = (draft: FmsgMessage, summary: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>;

export type FileCall = {
  runtime: FilesRuntime;
  ctx: ServerContext;
  caller: Caller;
  signal: AbortSignal;
  tool: string;
  /** The tool's arguments as parsed; the retry must repeat them. */
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

/** FileInputs that came with their bytes (inline or empty), as attachments to upload with the draft. */
export function inlineAttachments(files: CheckedFile[]): PreparedAttachment[] {
  return files.filter((f) => f.data).map((f) => ({ filename: f.filename, contentType: f.mimeType, sha256: f.sha256!, data: f.data! }));
}

/**
 * Check FileInputs for an initial call. Returns the checked files, a tool error when the metadata is refused, or
 * -32021 when files without data came on a request that did not declare `upload`.
 */
export function checkInitialFiles(call: FileCall, inputs: FileInput[], classicNames: string[]): CheckedFile[] | ToolResult {
  let files: CheckedFile[];
  try { files = checkFiles(inputs, call.runtime.config, classicNames); }
  catch (error) { return toolError(`${error instanceof Error ? error.message : String(error)}. Nothing was sent.`); }
  const pending = files.filter((f) => !f.data);
  if (pending.length && !declaresUpload(call.ctx)) {
    return call.runtime.missingUpload() ?? toolError(
      `${pending.map((f) => JSON.stringify(f.id)).join(", ")} ${pending.length === 1 ? "has" : "have"} no data, and this request did not ` +
      "declare upload support for the io.modelcontextprotocol/files extension. Include the file's data, or send it as filename with " +
      "data_base64 or data_text. Nothing was sent.",
    );
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
    const files: PendingFile[] = pending.map((f) => ({ id: f.id, filename: f.filename, size: f.size, ...(f.sha256 ? { sha256: f.sha256 } : {}), mimeType: f.mimeType }));
    const state: RoundState = {
      v: 2, tool: call.tool, args: argumentsHash(call.args), address: caller.address.toLowerCase(), draft: draft.id, round, exp, files,
      summary: { ...summary, redactions: draft.redactions, redacted: draft.redacted },
    };
    const requestState = await runtime.codec.mint(state, call.ctx);
    const result = runtime.requestUploads(runtime.uploadRequest(state, requestState));
    if (!result) throw new Error("this transport cannot deliver upload requests; send the files inline");
    return result;
  } catch (error) {
    await caller.client.deleteMessage(draft.id).catch(() => undefined);
    throw error;
  }
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
 * Handle a retry, in the spec's order. The SDK has already verified requestState's MAC, expiry and principal binding
 * (a failure there is answered with -32602 before the tool runs). Then:
 *
 * 1–2. The state must be this server's, for this tool, address and arguments, and not already used: else -32602.
 * 3. Each file must be in the draft with its declared size, and digest when one was given: else a tool error, and
 *    the call ends with its draft deleted.
 * 4. The call is claimed so it runs at most once. In this process that is the round record; across instances the
 *    fmsg host sends a draft only once, so a second send fails rather than sending twice.
 * 5. The tool finishes.
 */
export async function resumeUploads(call: FileCall, finish: Finish): Promise<ToolResult> {
  const { runtime, ctx, caller, signal, tool } = call;
  const invalid = (reason: string) => runtime.invalidRequestState(reason) ?? toolError(`requestState: ${reason}. Nothing was sent.`);
  const state = ctx.mcpReq.requestState<RoundState>();
  if (!state || typeof state !== "object" || state.v !== 2) return invalid("not one this server issued for file uploads");
  if (state.tool !== tool) return invalid(`issued by ${state.tool}, not ${tool}`);
  if (state.address !== caller.address.toLowerCase()) return invalid("issued to another fmsg address");
  if (state.args !== argumentsHash(call.args)) return invalid(`the arguments differ from the ${tool} call that requested these uploads`);
  const known = runtime.status(state.round);
  if (known && known.status !== "open") return invalid(`this ${tool} call was already ${known.status === "running" ? "being completed by another retry" : `completed (${known.outcome ?? "done"})`}`);

  if (!runtime.mark(state.round, "running", undefined, caller, state.draft)) return invalid(`this ${tool} call is already being completed by another retry`);
  let finished = false;
  const end = async (outcome: string) => {
    runtime.mark(state.round, "ended", outcome);
    finished = true;
    await discardDraft(caller, state.draft);
  };
  try {
    let draft: FmsgMessage;
    try { draft = await caller.client.getMessage(state.draft, signal); }
    catch (error) {
      if (error instanceof FmsgHttpError && error.status === 404) {
        runtime.mark(state.round, "ended", "its draft no longer exists");
        finished = true;
        return toolError(`the draft this ${tool} call staged its files in (${state.draft}) no longer exists, so the tool did not run and nothing was sent.`);
      }
      throw error;
    }
    if (draft.time !== null && draft.time !== undefined) {
      runtime.mark(state.round, "done", `message ${draft.id} was sent`);
      finished = true;
      return invalid(`this ${tool} call already completed: message ${draft.id} was sent`);
    }
    const attachments = draft.attachments ?? [];
    const missing = state.files.filter((f) => !attachments.some((a) => a.filename === f.filename));
    if (missing.length) {
      await end(`${missing.map((f) => f.id).join(", ")} did not arrive`);
      return toolError(`this server has not received ${missing.map((f) => JSON.stringify(f.id)).join(", ")}, so ${tool} did not run and nothing ` +
        "was sent. The draft was deleted; call the tool again, without requestState, to start over.");
    }
    for (const f of state.files) {
      const stored = attachments.find((a) => a.filename === f.filename)!;
      let ok = stored.size === f.size;
      if (ok && f.sha256) {
        const sha256 = runtime.verifiedSha256(`${state.draft}/${f.filename}`) ?? await storedSha256(caller, state.draft, f.filename, f.size, signal);
        ok = sha256 === f.sha256;
      }
      if (!ok) {
        await end(`${f.id} did not match its declared size or digest`);
        return toolError(`file ${JSON.stringify(f.id)} as received does not match its declared size (${f.size} bytes)` +
          `${f.sha256 ? ` and digest (${hexToBase64url(f.sha256)})` : ""}, so ${tool} did not run and nothing was sent. Call the tool again to retry.`);
      }
    }
    let result: CallToolResult;
    try { result = await finish(draft, state.summary, signal); }
    catch (error) {
      // Like a call without uploads, a failed send deletes its draft.
      await end("it failed");
      throw error;
    }
    const outcome = result.structuredContent as { id?: string; draft_id?: string } | undefined;
    runtime.mark(state.round, "done", outcome?.draft_id ? `draft ${outcome.draft_id} was created` : outcome?.id ? `message ${outcome.id} was sent` : undefined);
    finished = true;
    return result;
  } finally {
    // A failure while confirming the files (such as the host being unreachable) leaves the call open to retry.
    if (!finished) runtime.mark(state.round, "open");
  }
}
