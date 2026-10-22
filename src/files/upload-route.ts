/**
 * Upload targets: PUT /mcp/uploads/{token}. A target takes one file: the size and SHA-256 its call declared, from
 * the address it was issued to, before it expires. The bytes stream into the call's fmsg draft; nothing is staged
 * on this server. The client attaches the credential it presents to the MCP server (credentials: "include").
 */
import { sameAddress } from "../address.js";
import type { Caller } from "../context.js";
import { isoTime } from "../render.js";
import { streamIntoDraft } from "../upload.js";
import { type FilesRuntime, TARGET_PATH, type TargetClaims } from "./runtime.js";

/** The token in an upload target path, or undefined when the path is not one. */
export function targetToken(pathname: string): string | undefined {
  const token = pathname.slice(TARGET_PATH.length + 1);
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token) ? token : undefined;
}

const refuse = (status: number, error: string): Response => Response.json({ error }, { status });

/**
 * Receive an upload to a file-uploads extension target. Expected refusals are answered here; anything else (such as
 * the host refusing the draft attachment) is thrown for the HTTP layer to map, after the request body is drained so
 * the answer arrives.
 */
export async function receiveUpload(
  runtime: FilesRuntime, caller: Caller, token: string, request: Request, encoding: string | undefined, signal: AbortSignal,
): Promise<Response> {
  const verified = runtime.verifyTarget(token);
  if ("problem" in verified) {
    return verified.problem === "expired"
      ? refuse(410, `this upload target expired at ${isoTime(verified.claims!.e)}; retry the tool call without requestState to get a new one`)
      : refuse(404, "unknown upload target");
  }
  const claims: TargetClaims = verified.claims;
  if (!sameAddress(claims.a, caller.address)) return refuse(403, "this upload target was issued to another fmsg address");
  const call = runtime.status(claims.r)?.status;
  if (call === "done" || call === "ended") return refuse(409, "the tool call this upload target belongs to has already finished");
  return streamIntoDraft(runtime, caller, { draft: claims.d, filename: claims.n, size: claims.s, sha256: claims.h, mimeType: claims.t, fileId: claims.f },
    request, encoding, signal, "target");
}
