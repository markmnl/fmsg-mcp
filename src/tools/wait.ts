import * as z from "zod/v4";
import { resolveAddress } from "../address.js";
import { assembleThread, renderThread } from "../thread.js";
import { messageLine } from "../render.js";
import { waitForMessage } from "../wait.js";
import { READ_ONLY, type Register, idSchema, messageItem, ok, toItem, withCaller } from "./common.js";

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
        "previous result. On status \"timeout\" simply call again with the same arguments. Messages arriving on the " +
        "same thread within settle_seconds are batched into ONE result; reply once, to the newest (reply_target_id). " +
        "Your own messages, reactions and no-reply messages never qualify. Each call blocks at most " +
        `timeout_seconds (max ${maxWait}); stop looping when the user interrupts or the limits they set are reached.`,
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
        reply_target_id: z.string().nullable().describe("newest message of the batch; reply to this one"),
        messages: z.array(messageItem.extend({ body: z.string().nullable() })),
        pending_other_threads: z.array(z.object({ id: z.string(), from: z.string(), root_id: z.string().nullable() })),
        skipped: z.array(z.object({ id: z.string(), reason: z.enum(["own", "reaction", "no_reply", "from_mismatch", "other_thread"]) })).describe(
          "messages deliberately passed over; after_id has advanced past them",
        ),
        unclassified: z.array(z.object({ id: z.string(), from: z.string(), error: z.string() })).describe(
          "messages whose thread could not be determined; after_id is held before them, call again to retry",
        ),
        transport: z.enum(["websocket", "poll"]),
        note: z.string().nullable(),
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
            ...(from !== undefined ? { from: resolveAddress(from, deps.config).address } : {}),
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
        const structured = {
          status: result.status,
          after_id: result.after_id,
          thread_root_id: result.thread_root_id,
          reply_target_id: newest?.id ?? null,
          messages,
          pending_other_threads: result.pending_other_threads,
          skipped: result.skipped,
          unclassified: result.unclassified,
          transport: result.transport,
          note: result.note,
        };
        if (result.status === "timeout") {
          return ok(
            `No qualifying message arrived within ${timeout_seconds}s (after_id ${result.after_id}, ${result.transport})${result.note ? `; ${result.note}` : ""}. Call again to keep waiting.`,
            structured,
          );
        }
        const lines = [
          `${result.messages.length} new message${result.messages.length === 1 ? "" : "s"} (after_id ${result.after_id}, ${result.transport}):`,
          ...result.messages.map((m) => messageLine(m, caller.address)),
        ];
        if (result.pending_other_threads.length) {
          lines.push(`Also waiting on other threads: ${result.pending_other_threads.map((p) => `${p.id} from ${p.from}`).join(", ")}`);
        }
        if (result.unclassified.length) {
          lines.push(`Could not classify ${result.unclassified.map((u) => `${u.id} from ${u.from}`).join(", ")}; after_id is held before them, call again to retry.`);
        }
        if (result.note) lines.push(`Note: ${result.note}`);
        if (include_thread && newest) {
          const thread = await assembleThread(caller.client, caller.address, newest.id, {
            maxMessages: 50,
            maxBodyBytesPerMessage: 16_384,
            maxTotalBytes: 262_144,
          }, signal);
          lines.push("", renderThread(thread));
        } else if (newest) {
          for (const m of messages) if (m.body) lines.push("", `--- message ${m.id} from ${m.from} ---`, m.body);
          lines.push("", `Reply to message ${newest.id} with the reply tool.`);
        }
        return ok(lines.join("\n"), structured);
      }),
  );
};
