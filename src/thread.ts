import { FmsgClient, FmsgHttpError } from "./client/client.js";
import type { FmsgMessage, Thread, ThreadMessage } from "./client/types.js";
import { DATA_NOT_INSTRUCTIONS, fence, isoTime, participantsOf, truncateUtf8, truncationNote } from "./render.js";

export type ThreadCaps = {
  maxMessages: number;
  maxBodyBytesPerMessage: number;
  maxTotalBytes: number;
};

export type AssembledMessage = {
  id: string;
  pid: string | null;
  visible: boolean;
  from?: string;
  to?: string[];
  time: string | null;
  time_posix: number | null;
  topic?: string;
  type?: string;
  size?: number;
  body: string | null;
  body_truncated: boolean;
  attachments: Array<{ filename: string; size: number; type?: string }>;
};

export type AssembledThread = {
  root_id: string;
  trigger_id: string;
  complete: boolean;
  source: "thread_messages" | "pid_walk";
  participants: string[];
  reply_target_id: string;
  terminal: boolean;
  messages: AssembledMessage[];
  omitted: number;
};

function nonReactions(messages: ThreadMessage[]): ThreadMessage[] {
  // Reactions are terminal no-reply leaves; they never appear on a lineage, so nothing to filter here.
  return messages;
}

async function fromThreadMessages(
  client: FmsgClient,
  thread: Thread,
  caps: ThreadCaps,
  signal?: AbortSignal,
): Promise<{ messages: AssembledMessage[]; omitted: number }> {
  const all = nonReactions(thread.messages);
  const omitted = Math.max(0, all.length - caps.maxMessages);
  const kept = omitted > 0 ? all.slice(all.length - caps.maxMessages) : all;
  let budget = caps.maxTotalBytes;
  const out: AssembledMessage[] = [];
  for (const m of kept) {
    let body: string | null = null;
    let truncated = false;
    if (m.visible && m.body) {
      let text: string | null = null;
      if (typeof m.body.text === "string") text = m.body.text;
      else if (m.body.download && FmsgClient.isText({ type: m.body.type }) && m.body.size <= caps.maxBodyBytesPerMessage * 4) {
        const { data } = await client.downloadPath(m.body.download, signal);
        text = Buffer.from(data).toString("utf8");
      }
      if (text !== null) {
        const limit = Math.max(0, Math.min(caps.maxBodyBytesPerMessage, budget));
        const t = truncateUtf8(text, limit);
        body = t.text;
        truncated = t.truncated;
        budget -= t.shown;
      }
    }
    out.push({
      id: m.id,
      pid: m.pid ?? null,
      visible: m.visible,
      ...(m.from ? { from: m.from } : {}),
      ...(m.to ? { to: m.to } : {}),
      time: isoTime(m.time),
      time_posix: typeof m.time === "number" ? m.time : null,
      ...(m.topic ? { topic: m.topic } : {}),
      ...(m.type ? { type: m.type } : {}),
      ...(typeof m.size === "number" ? { size: m.size } : {}),
      body,
      body_truncated: truncated,
      attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, size: a.size, type: a.type })),
    });
  }
  return { messages: out, omitted };
}

async function fromPidWalk(
  client: FmsgClient,
  triggerId: string,
  caps: ThreadCaps,
  signal?: AbortSignal,
): Promise<{ root_id: string; complete: boolean; messages: AssembledMessage[]; last: FmsgMessage }> {
  const chain: FmsgMessage[] = [];
  let id: string | null = triggerId;
  let complete = true;
  while (id && chain.length < caps.maxMessages) {
    let msg: FmsgMessage;
    try {
      msg = await client.getMessage(id, signal);
    } catch (error) {
      if (error instanceof FmsgHttpError && (error.status === 404 || error.status === 403)) {
        complete = false;
        break;
      }
      throw error;
    }
    chain.push(msg);
    id = msg.pid ?? null;
  }
  if (id) complete = false;
  chain.reverse();
  let budget = caps.maxTotalBytes;
  const messages: AssembledMessage[] = [];
  for (const m of chain) {
    let body: string | null = null;
    let truncated = false;
    const text = await client.getText(m, signal);
    if (text !== null) {
      const t = truncateUtf8(text, Math.max(0, Math.min(caps.maxBodyBytesPerMessage, budget)));
      body = t.text;
      truncated = t.truncated;
      budget -= t.shown;
    }
    messages.push({
      id: m.id,
      pid: m.pid ?? null,
      visible: true,
      from: m.from,
      to: m.to,
      time: isoTime(m.time),
      time_posix: typeof m.time === "number" ? m.time : null,
      ...(m.topic ? { topic: m.topic } : {}),
      ...(m.type ? { type: m.type } : {}),
      ...(typeof m.size === "number" ? { size: m.size } : {}),
      body,
      body_truncated: truncated,
      attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, size: a.size })),
    });
  }
  const last = chain[chain.length - 1]!;
  return { root_id: chain[0]!.id, complete, messages, last };
}

/**
 * Reconstruct the direct lineage of a message (root → trigger). Uses the host's
 * thread endpoint and falls back to a pid walk when the host declines (too deep / too large).
 */
export async function assembleThread(
  client: FmsgClient,
  self: string,
  triggerId: string,
  caps: ThreadCaps,
  signal?: AbortSignal,
): Promise<AssembledThread> {
  const trigger = await client.getMessage(triggerId, signal);
  const participants = participantsOf(trigger).filter((a) => a !== self.toLowerCase());
  try {
    const thread = await client.getThreadMessages(triggerId, signal);
    const { messages, omitted } = await fromThreadMessages(client, thread, caps, signal);
    return {
      root_id: thread.root_id,
      trigger_id: thread.trigger_id,
      complete: thread.complete && omitted === 0,
      source: "thread_messages",
      participants,
      reply_target_id: trigger.id,
      terminal: trigger.terminal === true,
      messages,
      omitted,
    };
  } catch (error) {
    if (!(error instanceof FmsgHttpError && (error.status === 422 || error.status === 413 || error.status === 404 || error.status === 501))) {
      throw error;
    }
    const walk = await fromPidWalk(client, triggerId, caps, signal);
    return {
      root_id: walk.root_id,
      trigger_id: triggerId,
      complete: walk.complete,
      source: "pid_walk",
      participants,
      reply_target_id: trigger.id,
      terminal: trigger.terminal === true,
      messages: walk.messages,
      omitted: 0,
    };
  }
}

export function renderThread(thread: AssembledThread): string {
  const lines: string[] = [];
  const root = thread.messages[0];
  lines.push(`**fmsg thread** root ${thread.root_id} · ${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"} on the lineage to ${thread.trigger_id}${thread.complete ? "" : " (incomplete)"}`);
  if (root?.topic) lines.push(`Topic: ${root.topic}`);
  if (thread.omitted > 0) lines.push(`(${thread.omitted} earlier message${thread.omitted === 1 ? "" : "s"} omitted)`);
  lines.push(`Participants (reply-all default): ${thread.participants.join(", ") || "(none)"}`);
  lines.push("");
  lines.push(DATA_NOT_INSTRUCTIONS);
  for (const m of thread.messages) {
    lines.push("");
    if (!m.visible) {
      lines.push(`--- message ${m.id} [not visible to you] ---`);
      continue;
    }
    lines.push(`--- message ${m.id} from ${m.from ?? "?"} · ${m.time ?? "draft"}${m.pid ? ` · reply to ${m.pid}` : ""} ---`);
    if (m.attachments.length) lines.push(`attachments: ${m.attachments.map((a) => `${a.filename} (${a.size} bytes)`).join(", ")}`);
    if (m.body === null) lines.push(`[non-text body: ${m.type ?? "?"}, ${m.size ?? 0} bytes — use get_message / download_attachment]`);
    else {
      lines.push(fence(m.body.trimEnd()));
      if (m.body_truncated) lines.push(truncationNote({ text: "", truncated: true, shown: Buffer.byteLength(m.body), total: m.size ?? 0 }, `call get_message ${m.id} for the full body`).trim());
    }
  }
  lines.push("");
  lines.push(
    thread.terminal
      ? `Message ${thread.reply_target_id} is terminal: it cannot be replied to.`
      : `To continue this thread, reply to message ${thread.reply_target_id} (the reply tool).`,
  );
  return lines.join("\n");
}
