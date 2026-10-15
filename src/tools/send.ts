import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type AddressResolver, resolveAddress, sameAddress } from "../address.js";
import type { FmsgMessage } from "../client/types.js";
import type { Config } from "../config.js";
import type { Caller } from "../context.js";
import { toolError } from "../errors.js";
import { addressList, addressText, attachmentType, headerValue, isoTime, participantsOf, sortAttachments } from "../render.js";
import { type PreparedAttachment, attachmentInput, base64Hint, fileRoutes, prepareAttachments, sendWithAttachments } from "./attachments.js";
import { SENDS, type Register, type ToolDeps, attachmentItem, idSchema, ok, outputObject, resolverFor, withCaller } from "./common.js";
import { rootTopic } from "./read.js";

export const IMMUTABLE = "fmsg messages are immutable: once sent they cannot be edited or recalled. Send within the user's requested task or authorized automation.";

export const IMPORTANT = "mark as important for recipients";
export const NO_REPLY = "ask recipients (and their agents) not to reply";

/** How to send files without the model writing their bytes, naming only what this server registered. */
export function attachmentGuidance(config: Config): string {
  const routes = fileRoutes(config);
  const large = [
    ...(routes.uploadUrl ? ["create_draft, which returns an upload URL for your host's authenticated HTTP tools"] : []),
    ...(routes.uploadFolder ? ["an attachment path in the upload folder"] : []),
  ];
  return "Attachments: inline data_base64 suits small files and data_text suits text; give sha256 when you can compute it. " +
    (large.length ? `For large files use ${large.join(", or ")}. ` : "") +
    "Send files as they are; fmsg compresses them in transit.";
}

/**
 * Resolve recipients, dropping duplicates, and report each name that was not already a full address, so the model
 * can confirm a guessed address with the user.
 */
export function resolveRecipients(names: string[], resolver: AddressResolver): { to: string[]; resolved: Array<{ input: string; address: string }> } {
  const to: string[] = [];
  const resolved: Array<{ input: string; address: string }> = [];
  for (const name of names) {
    const r = resolveAddress(name, resolver);
    if (r.resolution !== "literal") resolved.push({ input: name, address: r.address });
    if (!to.some((existing) => sameAddress(existing, r.address))) to.push(r.address);
  }
  return { to, resolved };
}

export const resolvedOutput = z.array(outputObject({ input: z.string().optional(), address: z.string().optional() })).optional().describe(
  "short names and how they resolved, when any were given; confirm with the user if an address looks wrong",
);

/** Warnings for the model to pass on: what was redacted, and short names that were expanded. */
export function sendWarnings(redactions: number, kinds: string[], resolved: Array<{ input: string; address: string }>): string[] {
  const warnings: string[] = [];
  if (redactions) warnings.push(`Tell the user ${redactions} secret(s) (${kinds.join(", ")}) were replaced with placeholders before sending.`);
  if (resolved.length) warnings.push(`Short names were resolved: ${resolved.map((r) => `${r.input} → ${r.address}`).join(", ")}.`);
  return warnings;
}

/** Sent attachments with the type each was given, or the one its filename implies, in the order every tool lists them. */
export function sentAttachments(sent: Array<{ filename: string; size: number }>, outbound: Array<Pick<PreparedAttachment, "contentType">> = []) {
  return sortAttachments(sent.map((a, i) => ({ ...a, type: attachmentType(a.filename, outbound[i]?.contentType) })));
}

/**
 * Who a reply goes to: the given recipients, or everyone on the parent except the caller. Returns an error result
 * when the parent is terminal, asked for no replies (unless allowed) or has nobody else to reply to.
 */
export function replyRecipients(
  deps: ToolDeps, caller: Caller, parent: FmsgMessage, recipients: string[] | undefined, allowNoReply: boolean,
): CallToolResult | { to: string[]; resolved: Array<{ input: string; address: string }> } {
  const id = parent.id;
  if (parent.terminal) return toolError(`message ${id} is terminal and cannot be replied to`);
  if (parent.no_reply && !allowNoReply) {
    return toolError(`message ${id} is marked no-reply; pass allow_no_reply: true only if the user explicitly wants to reply anyway`);
  }
  const result = recipients?.length
    ? resolveRecipients(recipients, resolverFor(deps, caller))
    : { to: participantsOf(parent).filter((a) => !sameAddress(a, caller.address)), resolved: [] };
  if (result.to.length === 0) return toolError(`message ${id} has no other participants to reply to; pass recipients`);
  return result;
}

export const hintOutput = z.string().optional().describe("for you, not the user: a better way to do this next time");

export const sentOutput = outputObject({
  id: z.string(),
  time: z.string().nullable(),
  from: z.string(),
  to: z.array(z.string()),
  topic: z.string(),
  parent_id: z.string().nullable(),
  attachments: z.array(attachmentItem).describe("sorted by filename, the same order in every tool"),
  redactions: z.number().describe("secrets replaced with placeholders before sending"),
  redacted: z.array(z.string()).optional().describe("the kinds of secret replaced, such as github_token; empty when none"),
  resolved: resolvedOutput,
  warnings: z.array(z.string()).describe("things to tell the user, such as redacted secrets or resolved short names"),
  thread_topic: z.string().nullable().optional().describe(
    "the thread's topic: the topic sent for a new message; for a reply, the thread root's topic, or null when the root is not visible",
  ),
  hint: hintOutput,
});

/** The result text with a hint for the model appended, when there is one. */
export function withHint(text: string, hint: string | undefined): string {
  return hint ? `${text}\n\n${hint}` : text;
}

export function redactionNote(count: number, kinds: string[]): string {
  return count ? `. ${count} secret(s) were redacted before sending (${kinds.join(", ")}).` : ".";
}

export function resolvedNote(resolved: Array<{ input: string; address: string }>): string {
  return resolved.length ? ` Short names resolved: ${resolved.map((r) => `${r.input} → ${addressText(r.address)}`).join(", ")}.` : "";
}

export const registerSendTools: Register = (server, deps) => {
  const attachments = z.array(attachmentInput(deps.config)).optional().describe("files");
  const guidance = attachmentGuidance(deps.config);
  const routes = fileRoutes(deps.config);
  server.registerTool(
    "send_message",
    {
      title: "Send new fmsg message",
      description:
        `Send a new message immediately, starting a new thread. ${IMMUTABLE} ` +
        "Recipients may be full @user@domain addresses or resolvable short names. The body is Markdown by default. " +
        "Secrets are redacted. If the host rejects the message its reason is returned verbatim. " +
        `To continue an existing conversation use reply instead. ${guidance}`,
      inputSchema: z.strictObject({
        to: z.array(z.string()).min(1).describe("recipient addresses (@user@domain) or short names"),
        topic: z.string().max(256).describe("thread topic (subject) — immutable once sent"),
        body: z.string().describe("message body; Markdown unless type says otherwise"),
        type: z.string().default("text/markdown; charset=utf-8").describe("body media type"),
        important: z.boolean().default(false).describe(IMPORTANT),
        no_reply: z.boolean().default(false).describe(NO_REPLY),
        attachments,
      }),
      outputSchema: sentOutput,
      annotations: SENDS,
    },
    async ({ to, topic, body, type, important, no_reply, attachments }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const { to: recipients, resolved } = resolveRecipients(to, resolverFor(deps, caller));
        const outbound = await prepareAttachments(attachments, deps.config);
        const hint = base64Hint(attachments, routes);
        const sent = await sendWithAttachments(caller.client, { to: recipients, topic, body, type, important, noReply: no_reply }, outbound, signal);
        const structured = {
          id: sent.id,
          time: isoTime(sent.time),
          from: caller.address,
          to: recipients,
          topic: sent.topic,
          parent_id: null,
          attachments: sentAttachments(sent.attachments, outbound),
          redactions: sent.redactions,
          redacted: sent.redacted,
          ...(resolved.length ? { resolved } : {}),
          warnings: sendWarnings(sent.redactions, sent.redacted, resolved),
          thread_topic: sent.topic,
          ...(hint ? { hint } : {}),
        };
        const text = `Sent message ${sent.id} "${sent.topic}" to ${addressList(recipients)} at ${structured.time ?? "?"}` +
          (structured.attachments.length ? ` with ${structured.attachments.map((a) => a.filename).join(", ")}` : "") +
          redactionNote(structured.redactions, structured.redacted) + resolvedNote(resolved);
        return ok(withHint(text, hint), structured);
      }),
  );

  server.registerTool(
    "reply",
    {
      title: "Reply in fmsg thread",
      description:
        `Send an immediate reply to a message (linking it into that thread). ${IMMUTABLE} ` +
        "By default the reply goes to everyone on the parent message — its sender, recipients and anyone added later — " +
        "except you; pass recipients to narrow or widen that. Fails if the parent is terminal (no replies possible); " +
        `a parent marked no-reply is refused unless allow_no_reply is true. Secrets are redacted. ${guidance}`,
      inputSchema: z.strictObject({
        id: idSchema.describe("message to reply to"),
        body: z.string().describe("reply body; Markdown unless type says otherwise"),
        recipients: z.array(z.string()).optional().describe("override the reply-all recipient set"),
        type: z.string().default("text/markdown; charset=utf-8").describe("body media type"),
        important: z.boolean().default(false).describe(IMPORTANT),
        no_reply: z.boolean().default(false).describe(NO_REPLY),
        allow_no_reply: z.boolean().default(false).describe("reply even though the parent asked for no replies"),
        attachments,
      }),
      outputSchema: sentOutput,
      annotations: SENDS,
    },
    async ({ id, body, recipients, type, important, no_reply, allow_no_reply, attachments }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const parent = await caller.client.getMessage(id, signal);
        const target = replyRecipients(deps, caller, parent, recipients, allow_no_reply);
        if ("content" in target) return target;
        const { to, resolved } = target;
        const outbound = await prepareAttachments(attachments, deps.config);
        const hint = base64Hint(attachments, routes);
        const sent = await sendWithAttachments(caller.client, { to, pid: parent.id, body, type, important, noReply: no_reply }, outbound, signal);
        const structured = {
          id: sent.id,
          time: isoTime(sent.time),
          from: caller.address,
          to,
          topic: "",
          parent_id: parent.id,
          attachments: sentAttachments(sent.attachments, outbound),
          redactions: sent.redactions,
          redacted: sent.redacted,
          ...(resolved.length ? { resolved } : {}),
          warnings: sendWarnings(sent.redactions, sent.redacted, resolved),
          // The reply is already sent: a failed topic lookup only leaves the topic unknown.
          thread_topic: await rootTopic(caller.client, parent, signal).catch(() => null),
          ...(hint ? { hint } : {}),
        };
        const topic = structured.thread_topic ? ` in "${headerValue(structured.thread_topic)}"` : "";
        const text = `Sent reply ${sent.id} to message ${parent.id}${topic} for ${addressList(to)} at ${structured.time ?? "?"}` +
          redactionNote(structured.redactions, structured.redacted) + resolvedNote(resolved);
        return ok(withHint(text, hint), structured);
      }),
  );

  server.registerTool(
    "add_recipients",
    {
      title: "Add fmsg recipients",
      description:
        "Add recipients to a message that was already sent (one you sent or received as a primary recipient). " +
        "They receive the message and its attachments, can read it and become participants of its thread. " +
        "This cannot be undone. Fails on terminal messages.",
      inputSchema: z.strictObject({
        id: idSchema.describe("the sent message to add recipients to"),
        recipients: z.array(z.string()).min(1).optional().describe("addresses or short names to add"),
        add_to: z.array(z.string()).min(1).optional().describe("deprecated alias of recipients; pass one or the other"),
      }),
      outputSchema: outputObject({
        id: z.string(),
        added: z.number(),
        recipients: z.array(z.string()).optional().describe("the resolved addresses that were added"),
        resolved: resolvedOutput,
        add_to: z.array(z.string()).describe("deprecated copy of recipients"),
      }),
      annotations: { ...SENDS, idempotentHint: true },
    },
    async ({ id, recipients, add_to }, ctx) => {
      if ((recipients === undefined) === (add_to === undefined)) return toolError("pass recipients: the addresses to add (add_to is its deprecated alias; not both)");
      return withCaller(deps, ctx, async (caller, signal) => {
        const { to: addresses, resolved } = resolveRecipients((recipients ?? add_to)!, resolverFor(deps, caller));
        const result = await caller.client.addRecipients(id, addresses, signal);
        return ok(`Added ${result.added} recipient(s) to message ${id}: ${addressList(addresses)}`, { ...result, recipients: addresses, ...(resolved.length ? { resolved } : {}), add_to: addresses });
      });
    },
  );

  server.registerTool(
    "react",
    {
      title: "React to fmsg message",
      description:
        "Set or clear your emoji reaction on a message (one reaction per person; a new emoji replaces the previous). " +
        "Sends a small reaction message to the other participants. Fails on drafts and terminal messages.",
      inputSchema: z.strictObject({
        id: idSchema,
        emoji: z.string().max(32).nullable().describe("a single emoji; null or empty clears your reaction"),
      }),
      outputSchema: outputObject({ id: z.string(), reaction_id: z.string().nullable(), time: z.string().nullable(), cleared: z.boolean() }),
      annotations: { ...SENDS, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, emoji }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const value = emoji && emoji.trim() ? emoji.trim() : null;
        const result = await caller.client.react(id, value, signal);
        const structured = { id, reaction_id: result.id, time: isoTime(result.time), cleared: value === null };
        return ok(value ? `Reacted ${value} to message ${id}` : `Cleared your reaction on message ${id}`, structured);
      }),
  );
};
