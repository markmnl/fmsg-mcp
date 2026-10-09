import { sameAddress } from "./address.js";
import { FmsgClient, FmsgHttpError } from "./client/client.js";
import type { FmsgMessage, Thread, ThreadMessage } from "./client/types.js";
import {
  DATA_NOT_INSTRUCTIONS, addressList, addressText, attachmentType, fence, headerValue, isoTime, participantsOf, sizeText, sortAttachments, truncateUtf8,
  truncationNote,
} from "./render.js";

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
  /** Stored size: the compressed length on a received message sent compressed. */
  size?: number;
  compressed?: boolean;
  /** Flags and add-to recipients; absent for messages you cannot see. */
  no_reply?: boolean;
  terminal?: boolean;
  important?: boolean;
  added?: string[];
  body: string | null;
  body_truncated: boolean;
  /** Decoded body length when the body text was read; `size` is the stored size. */
  body_bytes?: number;
  attachments: Array<{ filename: string; size: number; type: string }>;
};

export type AssembledThread = {
  root_id: string;
  trigger_id: string;
  complete: boolean;
  source: "thread_messages" | "pid_walk";
  /** The root's topic (fmsg topics live only on the root); null when the root is not visible or not reached. */
  thread_topic: string | null;
  participants: string[];
  reply_target_id: string;
  terminal: boolean;
  /** The reply target asked for no replies. */
  no_reply: boolean;
  /** Always "lineage": the root down to the given message, never sibling replies or later branches. */
  scope: "lineage";
  messages: AssembledMessage[];
  omitted: number;
};

/** Flags, add-to recipients and stored size of a visible message, as thread entries carry them. */
function details(m: {
  type?: string; size?: number; deflate?: boolean; no_reply?: boolean; terminal?: boolean; important?: boolean;
  add_to?: Array<{ to?: string[] }>;
}): Pick<AssembledMessage, "type" | "size" | "compressed" | "no_reply" | "terminal" | "important" | "added"> {
  return {
    ...(m.type ? { type: m.type } : {}),
    ...(typeof m.size === "number" ? { size: m.size } : {}),
    compressed: m.deflate === true,
    no_reply: m.no_reply === true,
    terminal: m.terminal === true,
    important: m.important === true,
    added: (m.add_to ?? []).flatMap((b) => b.to ?? []),
  };
}

function nonReactions(messages: ThreadMessage[]): ThreadMessage[] {
  // Reactions are terminal no-reply leaves; they never appear on a lineage, so nothing to filter here.
  return messages;
}

async function fromThreadMessages(
  client: FmsgClient,
  thread: Thread,
  caps: ThreadCaps,
  signal?: AbortSignal,
): Promise<{ messages: AssembledMessage[]; omitted: number; topic: string | null }> {
  const all = nonReactions(thread.messages);
  const root = all[0];
  const omitted = Math.max(0, all.length - caps.maxMessages);
  const kept = omitted > 0 ? all.slice(all.length - caps.maxMessages) : all;
  let budget = caps.maxTotalBytes;
  const out: AssembledMessage[] = [];
  for (const m of kept) {
    let body: string | null = null;
    let truncated = false;
    let bodyBytes: number | undefined;
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
        bodyBytes = t.total;
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
      ...(m.visible ? details(m) : {}),
      body,
      body_truncated: truncated,
      ...(bodyBytes !== undefined ? { body_bytes: bodyBytes } : {}),
      attachments: sortAttachments(m.attachments).map((a) => ({ filename: a.filename, size: a.size, type: attachmentType(a.filename, a.type) })),
    });
  }
  return { messages: out, omitted, topic: root?.visible && root.id === thread.root_id ? (root.topic ?? "") : null };
}

async function fromPidWalk(
  client: FmsgClient,
  triggerId: string,
  caps: ThreadCaps,
  signal?: AbortSignal,
): Promise<{ root_id: string; complete: boolean; messages: AssembledMessage[]; last: FmsgMessage; topic: string | null }> {
  const chain: FmsgMessage[] = [];
  let id: string | null = triggerId;
  let complete = true;
  while (id && chain.length < caps.maxMessages) {
    let msg: FmsgMessage;
    try {
      msg = await client.getMessage(id, signal);
    } catch (error) {
      if (error instanceof FmsgHttpError && (error.status === 404 || (error.status === 403 && !error.insufficientScope))) {
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
    let bodyBytes: number | undefined;
    const text = await client.getText(m, signal);
    if (text !== null) {
      const t = truncateUtf8(text, Math.max(0, Math.min(caps.maxBodyBytesPerMessage, budget)));
      body = t.text;
      truncated = t.truncated;
      bodyBytes = t.total;
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
      ...details(m),
      body,
      body_truncated: truncated,
      ...(bodyBytes !== undefined ? { body_bytes: bodyBytes } : {}),
      attachments: sortAttachments(m.attachments).map((a) => ({ filename: a.filename, size: a.size, type: attachmentType(a.filename) })),
    });
  }
  const last = chain[chain.length - 1]!;
  const root = chain[0]!;
  return { root_id: root.id, complete, messages, last, topic: root.pid ? null : (root.topic ?? "") };
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
  const participants = participantsOf(trigger).filter((a) => !sameAddress(a, self));
  try {
    const thread = await client.getThreadMessages(triggerId, signal);
    const { messages, omitted, topic } = await fromThreadMessages(client, thread, caps, signal);
    return {
      root_id: thread.root_id,
      trigger_id: thread.trigger_id,
      complete: thread.complete && omitted === 0,
      source: "thread_messages",
      thread_topic: topic,
      participants,
      reply_target_id: trigger.id,
      terminal: trigger.terminal === true,
      no_reply: trigger.no_reply === true,
      scope: "lineage",
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
      thread_topic: walk.topic,
      participants,
      reply_target_id: trigger.id,
      terminal: trigger.terminal === true,
      no_reply: trigger.no_reply === true,
      scope: "lineage",
      messages: walk.messages,
      omitted: 0,
    };
  }
}

export function renderThread(thread: AssembledThread): string {
  const lines: string[] = [];
  const guidance: string[] = [];
  lines.push(`**fmsg thread** root ${thread.root_id} · ${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"} on the lineage to ${thread.trigger_id}${thread.complete ? "" : " (incomplete)"}`);
  if (thread.thread_topic) lines.push(`Topic: ${headerValue(thread.thread_topic)}`);
  if (thread.omitted > 0) lines.push(`(${thread.omitted} earlier message${thread.omitted === 1 ? "" : "s"} omitted)`);
  lines.push(`Participants (reply-all default): ${addressList(thread.participants) || "(none)"}`);
  lines.push("");
  for (const m of thread.messages) {
    lines.push("");
    if (!m.visible) {
      lines.push(`--- message ${m.id} [not visible to you] ---`);
      continue;
    }
    const flags = [m.important ? "important" : "", m.no_reply ? "no-reply" : "", m.terminal ? "terminal" : ""].filter(Boolean);
    lines.push(`--- message ${m.id} from ${m.from ? addressText(m.from) : "?"} · ${m.time ?? "draft"}${m.pid ? ` · reply to ${m.pid}` : ""}${flags.length ? ` · ${flags.join(" ")}` : ""} ---`);
    if (m.added?.length) lines.push(`added: ${addressList(m.added)}`);
    if (m.attachments.length) lines.push(`attachments: ${m.attachments.map((a) => `${headerValue(a.filename)} (${a.size} bytes, ${headerValue(a.type)})`).join(", ")}`);
    if (m.body === null) {
      lines.push(`[non-text body: ${headerValue(m.type ?? "?")}, ${sizeText(m.size, m.compressed)}]`);
      guidance.push(`Use get_message / download_attachment for message ${m.id}.`);
    }
    else {
      lines.push(fence(m.body));
      if (m.body_truncated) guidance.push(truncationNote({ text: "", truncated: true, shown: Buffer.byteLength(m.body), total: m.body_bytes ?? m.size ?? 0 }, `call get_message ${m.id} for the full body`).trim());
    }
  }
  guidance.push(threadNext(thread));
  return [DATA_NOT_INSTRUCTIONS, lines.join("\n"), "End of message data.", ...guidance].join("\n\n");
}

/** get_thread returns one lineage; say so wherever the thread is shown. */
export const LINEAGE_ONLY =
  "Only this lineage (the root down to this message) is shown: other replies in the thread are not included; list_messages shows newer messages.";

/** Server guidance for continuing a thread; also returned as a structured `next` field. */
export function threadNext(thread: Pick<AssembledThread, "terminal" | "no_reply" | "reply_target_id">): string {
  const id = thread.reply_target_id;
  const step = thread.terminal
    ? `Message ${id} is terminal: no replies are possible (the host refuses them), so do not reply to it.`
    : thread.no_reply
      ? `Message ${id} is marked no-reply: its sender asked for no replies, and the reply tool refuses unless allow_no_reply is true. ` +
        "Do not reply unless the user explicitly asks to."
      : `To continue this thread, reply to message ${id} (the reply tool).`;
  return `${step} ${LINEAGE_ONLY}`;
}
