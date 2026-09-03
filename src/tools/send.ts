import * as z from "zod/v4";
import { resolveAddresses } from "../address.js";
import { redactSecrets } from "../client/redact.js";
import type { OutboundAttachment } from "../client/types.js";
import { toolError } from "../errors.js";
import { isoTime, participantsOf } from "../render.js";
import { READ_ONLY, SENDS, type Register, idSchema, ok, withCaller } from "./common.js";

const IMMUTABLE = "fmsg messages are immutable: once sent they cannot be edited or recalled, so only send when the user has clearly asked to.";

const attachmentInput = z.object({
  filename: z.string().regex(/^[A-Za-z0-9._-]+$/u, "letters, digits, dot, underscore, hyphen only"),
  data_base64: z.string().min(1),
  content_type: z.string().optional(),
});

function decodeAttachments(items: z.infer<typeof attachmentInput>[] | undefined): OutboundAttachment[] {
  return (items ?? []).map((a) => {
    const data = Buffer.from(a.data_base64, "base64");
    if (data.byteLength === 0) throw new Error(`attachment ${a.filename} is empty or not valid base64`);
    return { filename: a.filename, data: new Uint8Array(data), ...(a.content_type ? { contentType: a.content_type } : {}) };
  });
}

const sentOutput = z.object({
  id: z.string(),
  time: z.string().nullable(),
  from: z.string(),
  to: z.array(z.string()),
  topic: z.string(),
  parent_id: z.string().nullable(),
  attachments: z.array(z.object({ filename: z.string(), size: z.number() })),
  redactions: z.number().describe("secrets replaced with placeholders before sending"),
  warnings: z.array(z.string()),
});

export const registerSendTools: Register = (server, deps) => {
  server.registerTool(
    "send_message",
    {
      title: "Send new fmsg message",
      description:
        `Send a new message immediately, starting a new thread. ${IMMUTABLE} ` +
        "Recipients may be full @user@domain addresses or resolvable short names. The body is Markdown by default. " +
        "Secrets (API keys, tokens) are redacted and the count reported. If the host rejects the message the host's " +
        "own reason is returned verbatim. To continue an existing conversation use reply instead.",
      inputSchema: z.object({
        to: z.array(z.string()).min(1).describe("recipient addresses (@user@domain) or short names"),
        topic: z.string().max(256).describe("thread topic (subject) — immutable once sent"),
        body: z.string().describe("message body; Markdown unless type says otherwise"),
        type: z.string().default("text/markdown; charset=utf-8").describe("body media type"),
        important: z.boolean().default(false),
        no_reply: z.boolean().default(false).describe("ask recipients (and their agents) not to reply"),
        attachments: z.array(attachmentInput).optional(),
      }),
      outputSchema: sentOutput,
      annotations: SENDS,
    },
    async ({ to, topic, body, type, important, no_reply, attachments }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const recipients = resolveAddresses(to, deps.config);
        const rb = redactSecrets(body);
        const rt = redactSecrets(topic);
        const sent = await caller.client.send({
          to: recipients,
          topic: rt.text,
          body: rb.text,
          type,
          important,
          noReply: no_reply,
          attachments: decodeAttachments(attachments),
          signal,
        });
        const structured = {
          id: sent.id,
          time: isoTime(sent.time),
          from: caller.address,
          to: recipients,
          topic: rt.text,
          parent_id: null,
          attachments: sent.attachments,
          redactions: rb.count + rt.count,
          warnings: [] as string[],
        };
        const text = `Sent message ${sent.id} "${rt.text}" to ${recipients.join(", ")} at ${structured.time ?? "?"}` +
          (sent.attachments.length ? ` with ${sent.attachments.map((a) => a.filename).join(", ")}` : "") +
          (structured.redactions ? `. ${structured.redactions} secret(s) were redacted before sending.` : ".");
        return ok(text, structured);
      }),
  );

  server.registerTool(
    "reply",
    {
      title: "Reply in fmsg thread",
      description:
        `Send an immediate reply to a message (linking it into that thread). ${IMMUTABLE} ` +
        "By default the reply goes to everyone on the parent message — its sender, recipients and anyone added later — " +
        "except you; pass recipients to narrow or widen that. Fails if the parent is terminal; a parent marked no-reply " +
        "is refused unless allow_no_reply is true. Secrets are redacted and the count reported.",
      inputSchema: z.object({
        id: idSchema.describe("message to reply to"),
        body: z.string(),
        recipients: z.array(z.string()).optional().describe("override the reply-all recipient set"),
        type: z.string().default("text/markdown; charset=utf-8"),
        important: z.boolean().default(false),
        no_reply: z.boolean().default(false),
        allow_no_reply: z.boolean().default(false).describe("reply even though the parent asked for no replies"),
        attachments: z.array(attachmentInput).optional(),
      }),
      outputSchema: sentOutput,
      annotations: SENDS,
    },
    async ({ id, body, recipients, type, important, no_reply, allow_no_reply, attachments }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const parent = await caller.client.getMessage(id, signal);
        if (parent.terminal) return toolError(`message ${id} is terminal and cannot be replied to`);
        if (parent.no_reply && !allow_no_reply) {
          return toolError(`message ${id} is marked no-reply; pass allow_no_reply: true only if the user explicitly wants to reply anyway`);
        }
        const warnings: string[] = [];
        const to = recipients?.length
          ? resolveAddresses(recipients, deps.config)
          : participantsOf(parent).filter((a) => a !== caller.address.toLowerCase());
        if (to.length === 0) return toolError(`message ${id} has no other participants to reply to; pass recipients`);
        const rb = redactSecrets(body);
        const sent = await caller.client.send({
          to,
          pid: parent.id,
          body: rb.text,
          type,
          important,
          noReply: no_reply,
          attachments: decodeAttachments(attachments),
          signal,
        });
        const structured = {
          id: sent.id,
          time: isoTime(sent.time),
          from: caller.address,
          to,
          topic: "",
          parent_id: parent.id,
          attachments: sent.attachments,
          redactions: rb.count,
          warnings,
        };
        const text = `Sent reply ${sent.id} to message ${parent.id} for ${to.join(", ")} at ${structured.time ?? "?"}` +
          (structured.redactions ? `. ${structured.redactions} secret(s) were redacted before sending.` : ".");
        return ok(text, structured);
      }),
  );

  server.registerTool(
    "add_recipients",
    {
      title: "Add fmsg recipients",
      description:
        "Add recipients to a message that was already sent (one you sent or received as a primary recipient). " +
        "They receive the message and become participants of its thread. This cannot be undone. Fails on terminal messages.",
      inputSchema: z.object({
        id: idSchema,
        add_to: z.array(z.string()).min(1).describe("addresses or short names to add"),
      }),
      outputSchema: z.object({ id: z.string(), added: z.number(), add_to: z.array(z.string()) }),
      annotations: { ...SENDS, idempotentHint: true },
    },
    async ({ id, add_to }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const addresses = resolveAddresses(add_to, deps.config);
        const result = await caller.client.addRecipients(id, addresses, signal);
        return ok(`Added ${result.added} recipient(s) to message ${id}: ${addresses.join(", ")}`, { ...result, add_to: addresses });
      }),
  );

  server.registerTool(
    "react",
    {
      title: "React to fmsg message",
      description:
        "Set or clear your emoji reaction on a message (one reaction per person; a new emoji replaces the previous). " +
        "Sends a small reaction message to the other participants. Fails on drafts and terminal messages.",
      inputSchema: z.object({
        id: idSchema,
        emoji: z.string().max(32).nullable().describe("a single emoji; null or empty clears your reaction"),
      }),
      outputSchema: z.object({ id: z.string(), reaction_id: z.string().nullable(), time: z.string().nullable(), cleared: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, emoji }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const value = emoji && emoji.trim() ? emoji.trim() : null;
        const result = await caller.client.react(id, value, signal);
        const structured = { id, reaction_id: result.id, time: isoTime(result.time), cleared: value === null };
        return ok(value ? `Reacted ${value} to message ${id}` : `Cleared your reaction on message ${id}`, structured);
      }),
  );

  // Kept read-only tools' annotation import in use for symmetry with other files.
  void READ_ONLY;
};
