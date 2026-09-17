import { redactSecrets } from "./redact.js";
import { readBytes } from "./stream.js";

/** An HTTP error from the fmsg Web API, with the status and the host's own error text. */
export class FmsgHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    /** Machine-readable `code` from the body, when the host sends one (thread routes). */
    readonly code?: string,
  ) {
    super(redactSecrets(message).text);
    if (this.code) this.code = redactSecrets(this.code).text;
    this.method = redactSecrets(method).text;
    this.path = redactSecrets(path).text;
    this.name = "FmsgHttpError";
  }
}

export async function readError(response: Response): Promise<{ message: string; code?: string }> {
  // Preserve canonical 400/413 JSON policy details. Other errors, including
  // proxy pages, get a bounded preview independent of message acceptance limits.
  const isJson = (response.headers.get("content-type") ?? "").toLowerCase().includes("json");
  let raw: string;
  if (!isJson || ![400, 413].includes(response.status)) {
    const { data, truncated } = await readBytes(response.body, 2048, true);
    raw = Buffer.from(data).toString("utf8");
    if (!isJson || truncated) return { message: (raw || `HTTP ${response.status}`) + (truncated ? "\n[upstream response truncated at 2048 bytes]" : "") };
  } else raw = await response.text();
  if (!raw) return { message: `HTTP ${response.status}` };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; code?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : `HTTP ${response.status}`;
    return typeof parsed.code === "string" ? { message, code: parsed.code } : { message };
  } catch {
    return { message: Buffer.byteLength(raw) > 2048 ? Buffer.from(raw).subarray(0, 2048).toString("utf8") + "\n[upstream response truncated at 2048 bytes]" : raw };
  }
}
