import type { CallToolResult } from "@modelcontextprotocol/server";
import { FmsgHttpError } from "./client/client.js";
import { safeErrorMessage } from "./client/redact.js";

/** Build an `isError` tool result the model can read and act on. */
export function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Model-facing description of a failure, with a status-specific hint where one helps. */
export function describeError(error: unknown, address?: string): string {
  if (error instanceof FmsgHttpError) {
    const where = `${error.method} ${error.path}`;
    const host = error.message;
    switch (error.status) {
      case 400:
        return `fmsg host rejected the request (${where}): ${host}`;
      case 401:
        return `fmsg API key was rejected (${where}): ${host}. The key may be revoked or expired; the user needs to issue a new one.`;
      case 403:
        return `not permitted (${where}): ${host}`;
      case 404:
        return `not found (${where}): ${host}${address ? ` — the message may not exist or may not be visible to ${address}` : ""}`;
      case 409:
        return `fmsg host refused (${where}): ${host}`;
      case 413:
        return `too large for this fmsg host (${where}): ${host}`;
      case 422:
        return `fmsg host could not process the request (${where}): ${host}${error.code ? ` [${error.code}]` : ""}`;
      default:
        return error.status >= 500
          ? `fmsg host error ${error.status} (${where}): ${host}`
          : `fmsg host returned ${error.status} (${where}): ${host}`;
    }
  }
  if (error instanceof Error && error.name === "AbortError") return "the request was cancelled or timed out";
  if (error instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/u.test(error.message)) {
    return `fmsg host unreachable: ${safeErrorMessage(error)}`;
  }
  return safeErrorMessage(error);
}
