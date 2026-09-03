import type { CallToolResult, McpServer, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { FmsgMessage, RecipientDelivery } from "../client/types.js";
import type { Config } from "../config.js";
import { type Caller, type CallerProvider, callerFor } from "../context.js";
import { describeError, toolError } from "../errors.js";
import { isoTime, preview } from "../render.js";

export type ToolDeps = { provider: CallerProvider; config: Config };

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const SENDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const idSchema = z.string().regex(/^[0-9]+$/u, "fmsg message ids are decimal integers").describe("fmsg message id");

export const attachmentItem = z.object({ filename: z.string(), size: z.number() });
export const deliveryItem = z.object({
  addr: z.string(),
  status: z.enum(["delivered", "pending", "failed"]),
  time: z.string().nullable(),
  code: z.number().nullable(),
  via: z.enum(["to", "add_to"]),
});

export const messageItem = z.object({
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
  size: z.number(),
  preview: z.string(),
  attachments: z.array(attachmentItem),
  reactions: z.array(z.object({ emoji: z.string(), from: z.array(z.string()) })),
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
    preview: preview(m),
    attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, size: a.size })),
    reactions: (m.reactions ?? []).map((r) => ({ emoji: r.emoji, from: r.from })),
  };
}

export function deliveryOf(m: FmsgMessage): z.infer<typeof deliveryItem>[] {
  const out: z.infer<typeof deliveryItem>[] = [];
  const push = (addr: string, entry: RecipientDelivery | undefined, via: "to" | "add_to") => {
    const time = entry?.time_delivered ?? null;
    const code = entry?.response_code ?? null;
    const status = time !== null ? "delivered" : code !== null ? "failed" : "pending";
    out.push({ addr, status, time, code, via });
  };
  m.to.forEach((addr, i) => push(addr, m.to_delivery?.[i], "to"));
  for (const batch of m.add_to ?? []) (batch.to ?? []).forEach((addr, i) => push(addr, batch.to_delivery?.[i], "add_to"));
  return out;
}

export function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
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
    return toolError(describeError(error));
  }
  try {
    return await body(caller, ctx.mcpReq.signal);
  } catch (error) {
    return toolError(describeError(error, caller.address));
  }
}

export type Register = (server: McpServer, deps: ToolDeps) => void;
