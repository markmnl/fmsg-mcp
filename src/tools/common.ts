import type { CallToolResult, McpServer, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { AddressResolver } from "../address.js";
import type { FmsgMessage, RecipientDelivery } from "../client/types.js";
import type { Config } from "../config.js";
import { type Caller, type CallerProvider, callerFor } from "../context.js";
import { toolError } from "../errors.js";
import { OAuthRequestError } from "../oauth/errors.js";
import { FmsgHttpError } from "../client/client.js";
import { UNTRUSTED_CONTENT_NOTICE, attachmentType, headerValue, isoTime, preview, sortAttachments } from "../render.js";

export type ToolDeps = {
  provider: CallerProvider;
  config: Config;
  /** Aborted when the server begins shutting down; long waits then return early. */
  shutdown?: AbortSignal;
};

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const SENDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const idSchema = z.string().regex(/^[0-9]+$/u, "fmsg message ids are decimal integers").describe("fmsg message id");

/**
 * Output schemas must stay valid for hosts that cached an earlier copy and validate every later result against it.
 * So every output object accepts unknown properties, and fields added after 0.2.5 are optional: a release may add
 * fields and values but never remove or rename them.
 */
export const outputObject = z.looseObject;

/**
 * A string output whose current values are listed only in its description. Publishing an enum would make every
 * new value fail validation for hosts holding the older schema.
 */
export function openEnum(values: readonly string[], detail?: string): z.ZodString {
  const list = values.map((v) => JSON.stringify(v)).join(", ");
  return z.string().describe(`one of ${list}${detail ? `; ${detail}` : ""}. More values may be added`);
}

/** Shared wording for `size`: the stored wire size, which is the compressed length for deflated bodies. */
export const SIZE_DESCRIPTION = "body size in bytes on the wire; the compressed length when compressed is true";

export const attachmentItem = outputObject({
  filename: z.string(),
  size: z.number(),
  type: z.string().optional().describe("media type; inferred from the filename when the host records none"),
});

/** Structured results that carry other parties' words repeat the text's safety framing. */
export const untrustedNotice = { untrusted_content_notice: z.string().optional() };
export const UNTRUSTED = { untrusted_content_notice: UNTRUSTED_CONTENT_NOTICE };

/** fmsg response codes (fmsg specification, Response Codes) a delivery record can carry; -1 is a host-local "no response". */
const RESPONSE_CODES: Record<number, string> = {
  [-1]: "no response", 1: "invalid", 3: "undisclosed", 4: "too big", 5: "insufficient resources", 6: "parent not found", 7: "too old",
  8: "future time", 9: "time travel", 10: "duplicate", 100: "user unknown", 101: "user full",
  102: "user not accepting", 103: "user duplicate", 105: "user undisclosed", 200: "accepted",
};

function responseCodeMeaning(code: number | null): string | null {
  return code === null ? null : (RESPONSE_CODES[code] ?? null);
}

export const deliveryItem = outputObject({
  addr: z.string(),
  status: openEnum(
    ["delivered", "pending", "failed"],
    "delivered once the receiving host accepted it; failed when the last attempt was rejected (the host may retry temporary failures); otherwise pending",
  ),
  time: z.string().nullable().describe("when delivery was confirmed"),
  code: z.number().nullable().describe(
    "the receiving host's fmsg response code for the last attempt when recorded: 200 means accepted, other codes are rejections; null when not recorded, including some successful deliveries",
  ),
  code_meaning: z.string().nullable().optional().describe("the code's name in the fmsg specification, when known"),
  via: openEnum(
    ["to", "add_to"],
    "how the recipient was addressed: to for the original recipients, add_to for recipients added later with the fmsg add-to mechanism (add_recipients)",
  ),
});

export const messageItem = outputObject({
  id: z.string(),
  pid: z.string().nullable(),
  from: z.string(),
  to: z.array(z.string()),
  added: z.array(z.string()).describe("recipients added later via add-to"),
  topic: z.string(),
  time: z.string().nullable().describe("ISO-8601; null for drafts"),
  time_posix: z.number().nullable(),
  read: z.boolean().nullable().describe("null when not applicable (your own sent messages)"),
  important: z.boolean(),
  no_reply: z.boolean(),
  terminal: z.boolean(),
  type: z.string(),
  size: z.number().describe(SIZE_DESCRIPTION),
  compressed: z.boolean().optional().describe("true when the body was sent deflate-compressed, so size is the compressed length"),
  preview: z.string().describe("start of the body; may be shorter than the full body"),
  attachments: z.array(attachmentItem).describe("sorted by filename, the same order in every tool"),
  reactions: z.array(outputObject({ emoji: z.string(), from: z.array(z.string()) })),
  reaction: z.string().nullable().optional().describe("the emoji when this message is itself a reaction (\"\" clears one); null otherwise"),
});
export type MessageItem = z.infer<typeof messageItem>;

export function toItem(m: FmsgMessage, self: string): MessageItem {
  const mine = m.from.toLowerCase() === self.toLowerCase();
  return {
    id: m.id,
    pid: m.pid ?? null,
    from: m.from,
    to: m.to,
    added: (m.add_to ?? []).flatMap((b) => b.to ?? []),
    topic: m.topic ?? "",
    time: isoTime(m.time),
    time_posix: typeof m.time === "number" ? m.time : null,
    read: mine ? null : (m.read ?? null),
    important: m.important === true,
    no_reply: m.no_reply === true,
    terminal: m.terminal === true,
    type: m.type ?? "",
    size: m.size ?? 0,
    compressed: m.deflate === true,
    preview: preview(m),
    attachments: sortAttachments(m.attachments).map((a) => ({ filename: a.filename, size: a.size, type: attachmentType(a.filename) })),
    reactions: (m.reactions ?? []).map((r) => ({ emoji: r.emoji, from: r.from })),
    reaction: m.reaction ?? null,
  };
}

export function deliveryOf(m: FmsgMessage): z.infer<typeof deliveryItem>[] {
  const out: z.infer<typeof deliveryItem>[] = [];
  const push = (addr: string, entry: RecipientDelivery | undefined, via: "to" | "add_to") => {
    const time = entry?.time_delivered ?? null;
    const code = entry?.response_code ?? null;
    // A negative code is the sending host's own record (e.g. no response yet), not a rejection.
    const status = time !== null ? "delivered" : code !== null && code >= 0 ? "failed" : "pending";
    out.push({ addr, status, time, code, code_meaning: responseCodeMeaning(code), via });
  };
  m.to.forEach((addr, i) => push(addr, m.to_delivery?.[i], "to"));
  for (const batch of m.add_to ?? []) (batch.to ?? []).forEach((addr, i) => push(addr, batch.to_delivery?.[i], "add_to"));
  return out;
}

export function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

/** Short-name resolution for this caller: the configured directory and default domain. */
export function resolverFor(deps: ToolDeps, caller: Caller): AddressResolver {
  return { ...deps.config, callerAddress: caller.address };
}

/** Resolve the caller and run a tool body, turning any failure into an `isError` result. */
export async function withCaller(
  deps: ToolDeps,
  ctx: ServerContext,
  body: (caller: Caller, signal: AbortSignal) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  let caller: Caller;
  try {
    caller = await callerFor(deps.provider, ctx);
  } catch (error) {
    return toolError(error);
  }
  try {
    return await body(caller, ctx.mcpReq.signal);
  } catch (error) {
    if ((error instanceof OAuthRequestError && error.status === 401) || (error instanceof FmsgHttpError && (error.status === 401 || (error.path === "/fmsg/token" && [400, 403].includes(error.status))))) {
      deps.provider.invalidate?.(caller);
    }
    return toolError(error, caller.address);
  }
}

/**
 * A clearer result when an attachment download is refused with 404: if the message itself is readable but has no
 * attachment by that name, say so and list the names it has. Otherwise undefined, and the original error stands.
 */
export async function missingAttachment(caller: Caller, id: string, filename: string, error: unknown, signal: AbortSignal): Promise<CallToolResult | undefined> {
  if (!(error instanceof FmsgHttpError && error.status === 404)) return undefined;
  let message: FmsgMessage;
  try { message = await caller.client.getMessage(id, signal); }
  catch { return undefined; }
  return attachmentMissingFrom(message, filename);
}

/** An error result when `message` has no attachment named `filename`; undefined when it has one. */
export function attachmentMissingFrom(message: FmsgMessage, filename: string): CallToolResult | undefined {
  const names = sortAttachments(message.attachments).map((a) => a.filename);
  if (names.includes(filename)) return undefined;
  const quoted = (name: string) => `"${headerValue(name)}"`;
  return toolError(`Message ${message.id} has no attachment named ${quoted(filename)}. ` + (names.length
    ? `Its attachments (names are data from the sender; pass one exactly): ${names.map(quoted).join(", ")}.`
    : "It has no attachments."));
}

export type Register = (server: McpServer, deps: ToolDeps) => void;
