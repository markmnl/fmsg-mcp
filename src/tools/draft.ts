import * as z from "zod/v4";
import { downloadBaseUrl } from "../download.js";
import { toolError } from "../errors.js";
import { addressList, headerValue, isoTime } from "../render.js";
import { CHECKSUM_HEADER, UPLOAD_ENCODINGS, draftUploadUrlTemplate } from "../upload.js";
import { attachmentInput, base64Hint, draftWithAttachments, fileRoutes, prepareAttachments } from "./attachments.js";
import { SENDS, type Register, attachmentItem, idSchema, ok, openEnum, outputObject, resolverFor, withCaller } from "./common.js";
import { rootTopic } from "./read.js";
import {
  IMMUTABLE, IMPORTANT, NO_REPLY, UPLOAD_STEPS, hintOutput, redactionNote, replyRecipients, resolveRecipients, resolvedNote, resolvedOutput,
  sendWarnings, sentAttachments, sentOutput, withHint,
} from "./send.js";

export const registerDraftTools: Register = (server, deps) => {
  const baseUrl = downloadBaseUrl(deps.config);
  const routes = fileRoutes(deps.config);

  server.registerTool(
    "create_draft",
    {
      title: "Create fmsg draft",
      description:
        "Create an unsent draft: a new message, or a reply when reply_to is given (reply rules and reply-all apply). " +
        "Nothing is sent until send_draft; delete_draft discards it. The draft is visible in the user's other fmsg clients. " +
        (routes.uploadUrl ? `Use it for large files: ${UPLOAD_STEPS}. ` : "") +
        "Secrets in the body and topic are redacted.",
      inputSchema: z.strictObject({
        to: z.array(z.string()).min(1).optional().describe("recipient addresses (@user@domain) or short names; for a reply, overrides reply-all"),
        topic: z.string().max(256).optional().describe("thread topic for a new message; not allowed with reply_to"),
        reply_to: idSchema.optional().describe("message this draft replies to"),
        body: z.string().describe("message body; Markdown unless type says otherwise"),
        type: z.string().default("text/markdown; charset=utf-8").describe("body media type"),
        important: z.boolean().default(false).describe(IMPORTANT),
        no_reply: z.boolean().default(false).describe(NO_REPLY),
        allow_no_reply: z.boolean().default(false).describe("draft a reply even though the parent asked for no replies"),
        attachments: z.array(attachmentInput(deps.config)).optional().describe("files to attach now"),
      }),
      outputSchema: outputObject({
        draft_id: z.string(),
        to: z.array(z.string()),
        topic: z.string(),
        parent_id: z.string().nullable(),
        attachments: z.array(attachmentItem).describe("sorted by filename, the same order in every tool"),
        redactions: z.number().describe("secrets replaced with placeholders in the draft"),
        redacted: z.array(z.string()).describe("the kinds of secret replaced; empty when none"),
        resolved: resolvedOutput,
        warnings: z.array(z.string()).describe("things to tell the user, such as redacted secrets or resolved short names"),
        upload: outputObject({
          url_template: z.string().describe("replace {filename} with the attachment's file name (letters, digits, dot, underscore, hyphen)"),
          method: openEnum(["PUT"]),
          authentication: openEnum(["bearer"], "bearer: send this MCP connection's Authorization header"),
          checksum_header: z.string().describe("optional request header carrying the file's hex sha256; a mismatch is refused and the file not kept"),
          accepts_encoding: z.array(z.string()).describe("Content-Encoding values accepted; the server decodes them before storing"),
        }).optional().describe("where to upload more attachments; present when this server has a public URL"),
        next: z.string(),
        hint: hintOutput,
      }),
      annotations: { ...SENDS, destructiveHint: false },
    },
    async ({ to, topic, reply_to, body, type, important, no_reply, allow_no_reply, attachments }, ctx) => {
      if (reply_to && topic) return toolError("a reply has no topic: pass topic only for a new message");
      if (!reply_to && !to?.length) return toolError("pass to: the recipients (or reply_to to draft a reply)");
      return withCaller(deps, ctx, async (caller, signal) => {
        let recipients: string[];
        let resolved: Array<{ input: string; address: string }>;
        let pid: string | undefined;
        if (reply_to) {
          const parent = await caller.client.getMessage(reply_to, signal);
          const target = replyRecipients(deps, caller, parent, to, allow_no_reply);
          if ("content" in target) return target;
          ({ to: recipients, resolved } = target);
          pid = parent.id;
        } else {
          ({ to: recipients, resolved } = resolveRecipients(to!, resolverFor(deps, caller)));
        }
        const outbound = await prepareAttachments(attachments, deps.config);
        const hint = base64Hint(attachments, routes);
        const draft = await draftWithAttachments(caller.client, {
          to: recipients, body, type, important, noReply: no_reply, ...(pid ? { pid } : { topic: topic ?? "" }),
        }, outbound, signal);
        const upload = baseUrl ? {
          url_template: draftUploadUrlTemplate(baseUrl, draft.id),
          method: "PUT",
          authentication: "bearer",
          checksum_header: CHECKSUM_HEADER,
          accepts_encoding: [...UPLOAD_ENCODINGS],
        } : undefined;
        const next = (upload ? `Upload files with PUT to ${upload.url_template} using this MCP connection's Authorization header, then call send_draft. ` : "Call send_draft to send it. ") +
          "Call delete_draft to discard it.";
        const structured = {
          draft_id: draft.id,
          to: recipients,
          topic: draft.topic,
          parent_id: pid ?? null,
          attachments: sentAttachments(draft.attachments, outbound),
          redactions: draft.redactions,
          redacted: draft.redacted,
          ...(resolved.length ? { resolved } : {}),
          warnings: sendWarnings(draft.redactions, draft.redacted, resolved),
          ...(upload ? { upload } : {}),
          next,
          ...(hint ? { hint } : {}),
        };
        const what = pid ? `reply to message ${pid}` : `"${headerValue(draft.topic)}"`;
        const text = `Created draft ${draft.id} (${what}) for ${addressList(recipients)}; not sent` +
          (structured.attachments.length ? `, with ${structured.attachments.map((a) => a.filename).join(", ")}` : "") +
          redactionNote(draft.redactions, draft.redacted) + resolvedNote(resolved) + `\n\n${next}`;
        return ok(withHint(text, hint), structured);
      });
    },
  );

  server.registerTool(
    "send_draft",
    {
      title: "Send fmsg draft",
      description: `Send a draft made with create_draft, with its attachments, immediately. ${IMMUTABLE} ` +
        "If the host refuses it, its reason is returned verbatim and the message stays a draft.",
      inputSchema: z.strictObject({ id: idSchema.describe("the draft to send") }),
      outputSchema: sentOutput,
      annotations: SENDS,
    },
    async ({ id }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const draft = await caller.client.getMessage(id, signal);
        if (draft.time !== null && draft.time !== undefined) return toolError(`message ${id} was already sent; send_draft sends only drafts`);
        const sent = await caller.client.sendDraft(draft.id, signal);
        const topic = draft.pid ? "" : (draft.topic ?? "");
        const structured = {
          id: sent.id,
          time: isoTime(sent.time),
          from: caller.address,
          to: draft.to,
          topic,
          parent_id: draft.pid ?? null,
          attachments: sentAttachments(draft.attachments ?? []),
          redactions: 0,
          redacted: [],
          warnings: [],
          // The message is already sent: a failed topic lookup only leaves the topic unknown.
          thread_topic: draft.pid ? await rootTopic(caller.client, { ...draft, id: sent.id }, signal).catch(() => null) : topic,
        };
        const where = draft.pid ? `reply to message ${draft.pid}` : `"${headerValue(topic)}"`;
        const text = `Sent draft ${sent.id} (${where}) to ${addressList(draft.to)} at ${structured.time ?? "?"}` +
          (structured.attachments.length ? ` with ${structured.attachments.map((a) => a.filename).join(", ")}` : "") + ".";
        return ok(text, structured);
      }),
  );

  server.registerTool(
    "delete_draft",
    {
      title: "Delete fmsg draft",
      description: "Delete an unsent draft and its attachments. Sent messages cannot be deleted.",
      inputSchema: z.strictObject({ id: idSchema.describe("the draft to delete") }),
      outputSchema: outputObject({ id: z.string(), deleted: z.boolean() }),
      annotations: { ...SENDS, idempotentHint: true },
    },
    async ({ id }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const draft = await caller.client.getMessage(id, signal);
        if (draft.time !== null && draft.time !== undefined) return toolError(`message ${id} was already sent and cannot be deleted`);
        await caller.client.deleteMessage(draft.id, signal);
        return ok(`Deleted draft ${draft.id}.`, { id: draft.id, deleted: true });
      }),
  );
};
