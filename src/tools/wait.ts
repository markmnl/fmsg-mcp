import * as z from "zod/v4";
import { resolveAddress } from "../address.js";
import { assembleThread, renderThread } from "../thread.js";
import { DATA_NOT_INSTRUCTIONS, fence, headerValue, messageData, messageLine } from "../render.js";
import { type Skipped, waitForMessage } from "../wait.js";
import { READ_ONLY, type Register, UNTRUSTED, idSchema, messageItem, ok, resolverFor, toItem, untrustedNotice, withCaller } from "./common.js";

/** Skipped reactions as one line each, for the data block. */
function reactionLines(skipped: Skipped[]): string[] {
  return skipped.filter((s) => s.emoji !== undefined).map((s) =>
    `- ${s.id} from ${headerValue(s.from)}: ${s.emoji ? `reacted ${headerValue(s.emoji)}` : "cleared a reaction"}${s.reaction_to ? ` on message ${s.reaction_to}` : ""}`);
}

export const registerWaitTools: Register = (server, deps) => {
  const maxWait = deps.config.waitMaxSeconds;
  server.registerTool(
    "wait_for_message",
    {
      title: "Wait for next fmsg message",
      description:
        "Block until the next inbound message arrives (pushed over the fmsg host's WebSocket) and return it with its " +
        "thread context so you can answer with reply. Use this when the user asks you to chat, converse, keep replying, " +
        "auto-reply, or respond to the next message. Loop: wait → reply → wait again passing the after_id from the " +
        "previous result. On status \"timeout\" simply call again with the same arguments and the returned after_id, " +
        "which is never older than the newest inbox message when the call started, so nothing is replayed (\"0\" means " +
        "the inbox was empty and is safe to pass). Messages arriving on the same thread within settle_seconds are " +
        "batched into ONE result; reply once, to the newest (reply_target_id); the result's next field says what to do. " +
        "Your own messages, reactions and no-reply messages never qualify; they are listed in skipped. Each call blocks " +
        `at most timeout_seconds (max ${maxWait}); stop looping when the user interrupts or the limits they set are reached. ` +
        "In chat hosts each wait is a model turn: tell the user you are listening and for how long rather than " +
        "looping silently for long periods.",
      inputSchema: z.object({
        after_id: idSchema.optional().describe(
          "only messages with a greater id qualify; pass the after_id from the previous result. Omit on the first call to wait for messages arriving from now on",
        ),
        thread_of: idSchema.optional().describe("only accept messages in this message's thread"),
        from: z.string().optional().describe("only accept messages from this address or short name"),
        timeout_seconds: z.number().int().min(1).max(maxWait).default(Math.min(90, maxWait)),
        settle_seconds: z.number().int().min(0).max(30).default(3).describe("after the first message, keep collecting same-thread messages for this long"),
        include_thread: z.boolean().default(true).describe("include the assembled thread context of the newest message"),
      }),
      outputSchema: z.object({
        status: z.enum(["message", "timeout"]),
        after_id: z.string().describe("pass this as after_id on the next call"),
        thread_root_id: z.string().nullable(),
        thread_topic: z.string().nullable().describe("the thread root's topic (replies carry none); null when unknown"),
        reply_target_id: z.string().nullable().describe("newest message of the batch; reply to this one"),
        messages: z.array(messageItem.extend({ body: z.string().nullable() })),
        pending_other_threads: z.array(z.object({ id: z.string(), from: z.string(), root_id: z.string().nullable() })),
        skipped: z.array(z.object({
          id: z.string(),
          reason: z.enum(["own", "reaction", "no_reply", "from_mismatch", "other_thread"]),
          from: z.string(),
          emoji: z.string().optional().describe("for reactions: the emoji (\"\" clears a reaction)"),
          reaction_to: z.string().nullable().optional().describe("for reactions: the message reacted to"),
        })).describe("messages deliberately passed over; after_id has advanced past them"),
        unclassified: z.array(z.object({ id: z.string(), from: z.string(), error: z.string() })).describe(
          "messages whose thread could not be determined; after_id is held before them, call again to retry",
        ),
        transport: z.enum(["websocket", "poll"]),
        note: z.string().nullable(),
        next: z.string().describe("what to do with this result"),
        ...untrustedNotice,
      }),
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    async ({ after_id, thread_of, from, timeout_seconds, settle_seconds, include_thread }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const progressToken = ctx.mcpReq._meta?.progressToken;
        const result = await waitForMessage(
          caller.client,
          caller.address,
          {
            ...(after_id !== undefined ? { afterId: after_id } : {}),
            ...(thread_of !== undefined ? { threadOf: thread_of } : {}),
            ...(from !== undefined ? { from: resolveAddress(from, resolverFor(deps, caller)).address } : {}),
            timeoutMs: timeout_seconds * 1000,
            settleMs: settle_seconds * 1000,
            onTick: (elapsed) => {
              if (progressToken === undefined) return;
              void ctx.mcpReq
                .notify({
                  method: "notifications/progress",
                  params: { progressToken, progress: Math.round(elapsed / 1000), total: timeout_seconds, message: "waiting for fmsg messages" },
                })
                .catch(() => undefined);
            },
          },
          signal,
        );
        const messages = await Promise.all(
          result.messages.map(async (m) => ({ ...toItem(m, caller.address), body: await caller.client.getText(m, signal) })),
        );
        const newest = result.messages[result.messages.length - 1];
        const keepWaiting = `call wait_for_message with after_id "${result.after_id}"${thread_of !== undefined ? ` and thread_of "${thread_of}"` : ""} to keep listening`;
        const next = !newest
          ? `No new message yet; ${keepWaiting}, unless the user's time limit is reached.`
          : newest.terminal
            ? `Message ${newest.id} is terminal and cannot be replied to; ${keepWaiting}.`
            : `Reply to message ${newest.id} with the reply tool, then ${keepWaiting}.`;
        const structured = {
          status: result.status,
          after_id: result.after_id,
          thread_root_id: result.thread_root_id,
          thread_topic: result.thread_topic,
          reply_target_id: newest?.id ?? null,
          messages,
          pending_other_threads: result.pending_other_threads,
          skipped: result.skipped,
          unclassified: result.unclassified,
          transport: result.transport,
          note: result.note,
          next,
          ...UNTRUSTED,
        };
        const reactions = reactionLines(result.skipped);
        if (result.status === "timeout") {
          const waited = `No qualifying message arrived within ${timeout_seconds}s (after_id ${result.after_id}, ${result.transport})${result.note ? `; ${result.note}` : ""}. Call again to keep waiting.`;
          return ok(reactions.length ? `${waited}\n\nSkipped reactions:\n${messageData(reactions.join("\n"))}` : waited, structured);
        }
        const lines = [
          `${result.messages.length} new message${result.messages.length === 1 ? "" : "s"} (after_id ${result.after_id}, ${result.transport}):`,
          messageData(result.messages.map((m) => messageLine(m, caller.address)).join("\n")),
        ];
        if (reactions.length) lines.push(`Skipped reactions:\n${messageData(reactions.join("\n"))}`);
        if (result.pending_other_threads.length) {
          lines.push(`Also waiting on other threads: ${result.pending_other_threads.map((p) => p.id).join(", ")}`);
        }
        if (result.unclassified.length) {
          lines.push(`Could not classify ${result.unclassified.map((u) => u.id).join(", ")}; after_id is held before them, call again to retry.`);
        }
        if (result.note) lines.push(`Note: ${result.note}`);
        if (include_thread && newest) {
          const thread = await assembleThread(caller.client, caller.address, newest.id, {
            maxMessages: 50,
            maxBodyBytesPerMessage: 16_384,
            maxTotalBytes: 262_144,
          }, signal);
          lines.push("", renderThread(thread), "", next);
        } else if (newest) {
          lines.push("", DATA_NOT_INSTRUCTIONS);
          for (const m of messages) if (m.body !== null) lines.push("", `--- message ${m.id} from ${headerValue(m.from)} ---`, fence(m.body));
          lines.push("", "End of message data.");
          lines.push("", next);
        }
        return ok(lines.join("\n"), structured);
      }),
  );
};
