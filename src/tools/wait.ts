import * as z from "zod/v4";
import { compareMessageIds } from "../client/message-id.js";
import { resolveAddress } from "../address.js";
import { assembleThread, renderThread } from "../thread.js";
import { DATA_NOT_INSTRUCTIONS, addressText, fence, headerValue, messageData, messageLine } from "../render.js";
import { type Pending, type Skipped, waitForMessage } from "../wait.js";
import {
  READ_ONLY, type Register, UNTRUSTED, idSchema, messageItem, ok, openEnum, outputObject, resolverFor, toItem, untrustedNotice, withCaller,
} from "./common.js";

/** Skipped reactions as one line each, for the data block. */
function reactionLines(skipped: Skipped[]): string[] {
  return skipped.filter((s) => s.emoji !== undefined).map((s) =>
    `- ${s.id} from ${addressText(s.from)}: ${s.emoji ? `reacted ${headerValue(s.emoji)}` : "cleared a reaction"}${s.reaction_to ? ` on message ${s.reaction_to}` : ""}`);
}

/**
 * Messages that arrived on other threads (or beyond the batch limit) during the settle window. They are not
 * returned and after_id moves past them, so the next step must name each one; otherwise a model following `next`
 * never sees them.
 */
function pendingStep(pending: Pending[], batchRoot: string | null): string {
  if (!pending.length) return "";
  const described = pending.map((p) => {
    const where = p.root_id === null ? "" : p.root_id === batchRoot ? " in this thread (beyond the batch limit)" : ` in another thread (root ${p.root_id})`;
    return `message ${p.id}${where}`;
  });
  const many = pending.length > 1;
  return `Also new and not included here: ${described.join(", ")}. after_id has moved past ${many ? "them" : "it"}, so ` +
    `the next wait will not return ${many ? "them" : "it"}: read ${many ? "each" : "it"} with get_thread (or get_message) ` +
    `${pending.map((p) => `"${p.id}"`).join(", ")} and reply if appropriate before waiting again.`;
}

export const registerWaitTools: Register = (server, deps) => {
  const maxWait = deps.config.waitMaxSeconds;
  server.registerTool(
    "wait_for_message",
    {
      title: "Wait for next fmsg message",
      description:
        "Block until the next inbound message arrives and return it with its thread context, so you can answer with reply.\n" +
        "When: the user asks you to chat, keep replying or respond to the next message.\n" +
        "Loop: wait → reply → wait again, passing each result's after_id. On \"timeout\" or \"interrupted\" (server " +
        "restart) call again with the returned after_id; nothing is replayed or lost. Same-thread messages arriving " +
        "within settle_seconds come as ONE result: reply once, to reply_target_id; next says what to do.\n" +
        "Skipped: your own messages, reactions and no-reply messages (listed in skipped). Messages on other threads " +
        "are not returned: after_id moves past them and pending_ids lists them; read them with get_thread before " +
        "waiting again.\n" +
        `Limits: each call blocks at most timeout_seconds (max ${maxWait}). In chat hosts each wait is a model turn: ` +
        "tell the user you are listening and for how long, and stop when they interrupt or their limits are reached.",
      inputSchema: z.strictObject({
        after_id: idSchema.optional().describe(
          "only messages with a greater id qualify; pass the after_id from the previous result. Omit on the first call to wait for messages arriving from now on",
        ),
        thread_of: idSchema.optional().describe("only accept messages in this message's thread"),
        from: z.string().optional().describe("only accept messages from this address or short name"),
        timeout_seconds: z.number().int().min(1).max(maxWait).default(Math.min(90, maxWait)).describe("longest this call blocks"),
        settle_seconds: z.number().int().min(0).max(30).default(3).describe("after the first message, keep collecting same-thread messages for this long"),
        include_thread: z.boolean().default(true).describe("include the assembled thread context of the newest message"),
      }),
      outputSchema: outputObject({
        status: openEnum(["message", "timeout", "interrupted"], "interrupted: the server is restarting; call again with after_id"),
        after_id: z.string().describe("pass this as after_id on the next call"),
        thread_root_id: z.string().nullable(),
        thread_topic: z.string().nullable().optional().describe("the thread root's topic (replies carry none); null when unknown"),
        reply_target_id: z.string().nullable().describe("newest message of the batch; reply to this one"),
        messages: z.array(messageItem.extend({ body: z.string().nullable() })),
        pending_other_threads: z.array(outputObject({ id: z.string(), from: z.string(), root_id: z.string().nullable() })).describe(
          "new messages not returned here (other threads, or beyond the batch limit); after_id has moved past them, so read each with get_thread or get_message",
        ),
        pending_ids: z.array(z.string()).optional().describe("ids of pending_other_threads, oldest first: read these before waiting again"),
        skipped: z.array(outputObject({
          id: z.string(),
          reason: openEnum(["own", "reaction", "no_reply", "from_mismatch", "other_thread"]),
          from: z.string().optional(),
          emoji: z.string().optional().describe("for reactions: the emoji (\"\" clears a reaction)"),
          reaction_to: z.string().nullable().optional().describe("for reactions: the message reacted to"),
        })).describe("messages deliberately passed over; after_id has advanced past them"),
        unclassified: z.array(outputObject({ id: z.string(), from: z.string(), error: z.string() })).describe(
          "messages whose thread could not be determined; after_id is held before them, call again to retry",
        ),
        transport: openEnum(["websocket", "poll"]),
        note: z.string().nullable(),
        next: z.string().optional().describe("what to do with this result"),
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
            ...(deps.shutdown ? { interrupt: deps.shutdown } : {}),
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
        const pending = [...result.pending_other_threads].sort((a, b) => compareMessageIds(a.id, b.id));
        const alsoNew = pendingStep(pending, result.thread_root_id);
        const thenWait = alsoNew ? `${alsoNew} Then ${keepWaiting}.` : "";
        const next = result.status === "interrupted"
          ? `The server is restarting; ${keepWaiting}. No messages are lost.`
          : !newest
          ? `No new message yet; ${keepWaiting}, unless the user's time limit is reached.`
          : newest.terminal
            ? `Message ${newest.id} is terminal and cannot be replied to.${thenWait ? ` ${thenWait}` : ` Next, ${keepWaiting}.`}`
            : `Reply to message ${newest.id} with the reply tool.${thenWait ? ` ${thenWait}` : ` Then ${keepWaiting}.`}`;
        const structured = {
          status: result.status,
          after_id: result.after_id,
          thread_root_id: result.thread_root_id,
          thread_topic: result.thread_topic,
          reply_target_id: newest?.id ?? null,
          messages,
          pending_other_threads: pending,
          pending_ids: pending.map((p) => p.id),
          skipped: result.skipped,
          unclassified: result.unclassified,
          transport: result.transport,
          note: result.note,
          next,
          ...UNTRUSTED,
        };
        const reactions = reactionLines(result.skipped);
        if (result.status === "interrupted") return ok(`${next} (after_id ${result.after_id})`, structured);
        if (result.status === "timeout") {
          const waited = `No qualifying message arrived within ${timeout_seconds}s (after_id ${result.after_id}, ${result.transport})${result.note ? `; ${result.note}` : ""}. Call again to keep waiting.`;
          return ok(reactions.length ? `${waited}\n\nSkipped reactions:\n${messageData(reactions.join("\n"))}` : waited, structured);
        }
        const lines = [
          `${result.messages.length} new message${result.messages.length === 1 ? "" : "s"} (after_id ${result.after_id}, ${result.transport}):`,
          messageData(result.messages.map((m) => messageLine(m, caller.address)).join("\n")),
        ];
        if (reactions.length) lines.push(`Skipped reactions:\n${messageData(reactions.join("\n"))}`);
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
          for (const m of messages) if (m.body !== null) lines.push("", `--- message ${m.id} from ${addressText(m.from)} ---`, fence(m.body));
          lines.push("", "End of message data.");
          lines.push("", next);
        }
        return ok(lines.join("\n"), structured);
      }),
  );
};
