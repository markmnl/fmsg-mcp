import * as z from "zod/v4";
import { FmsgHttpError } from "../client/client.js";
import type { FmsgMessage, SearchResult } from "../client/types.js";
import { addressText, headerValue, isoTime, messageData } from "../render.js";
import { type SearchSupportCache, searchSupport } from "../search-support.js";
import { READ_ONLY, type Register, UNTRUSTED, ok, openEnum, outputObject, untrustedNotice, withCaller } from "./common.js";

const threadItem = outputObject({
  root: z.string().describe("the thread's first message you can see; pass it (or match.id) to get_thread"),
  topic: z.string().describe("the thread's topic, from its first message"),
  time: z.string().nullable().describe("ISO-8601 time of the newest message; null for a thread of drafts"),
  message_count: z.number().describe("messages in the thread, not counting reactions or edits"),
  unread: z.number().describe("messages in the thread you haven't read"),
  participants: z.array(z.string()).describe("everyone in the thread except you"),
  latest: outputObject({ id: z.string(), from: z.string(), time: z.string().nullable() }).nullable()
    .describe("the newest message"),
  match: outputObject({
    id: z.string().describe("the newest message in the thread with the words"),
    field: openEnum(["body", "topic", "file", "from", "to"], "where the words were found"),
    text: z.string().describe("the text that matched: part of the body, the topic, a file name or an address"),
  }).nullable().describe("null when query is empty"),
});

type ThreadItem = z.infer<typeof threadItem>;

/** A visible message, not a reaction or an edit (which hosts fold into the message they change). */
function counted(m: FmsgMessage): boolean {
  return m.edit !== true && (m.reaction === null || m.reaction === undefined);
}

/** Summarise each thread from the messages the search returned with it. */
export function summarizeThreads(result: SearchResult, self: string): ThreadItem[] {
  const byId = new Map(result.messages.map((m) => [m.id, m]));
  const roots = new Set(result.threads.map((t) => t.root));
  const members = new Map<string, FmsgMessage[]>(result.threads.map((t) => [t.root, []]));
  for (const m of result.messages) {
    // A message belongs to the thread whose root it reaches through its visible parents.
    let at: FmsgMessage | undefined = m;
    const seen = new Set<string>();
    while (at && !roots.has(at.id) && at.pid && !seen.has(at.id)) {
      seen.add(at.id);
      at = byId.get(at.pid);
    }
    if (at && roots.has(at.id)) members.get(at.id)!.push(m);
  }
  const me = self.toLowerCase();
  return result.threads.map((t) => {
    const messages = (members.get(t.root) ?? []).filter(counted);
    const root = byId.get(t.root);
    const people = new Map<string, string>();
    for (const m of messages) {
      for (const a of [m.from, ...m.to, ...(m.add_to ?? []).flatMap((b) => b.to ?? [])]) {
        if (a && a.toLowerCase() !== me && !people.has(a.toLowerCase())) people.set(a.toLowerCase(), a);
      }
    }
    const latest = messages.reduce<FmsgMessage | undefined>((best, m) => (best === undefined || (m.time ?? 0) >= (best.time ?? 0) ? m : best), undefined);
    return {
      root: t.root,
      topic: root?.topic ?? "",
      time: isoTime(t.time),
      message_count: messages.length,
      unread: messages.filter((m) => m.from.toLowerCase() !== me && m.read === false).length,
      participants: [...people.values()],
      latest: latest ? { id: latest.id, from: latest.from, time: isoTime(latest.time) } : null,
      match: t.match ? { id: t.match.id, field: t.match.field, text: t.match.text } : null,
    };
  });
}

function threadLine(t: ThreadItem): string {
  const parts = [`**${t.root}**`, t.topic ? `"${headerValue(t.topic)}"` : "(no topic)"];
  parts.push(`${t.message_count} message${t.message_count === 1 ? "" : "s"}${t.unread ? `, ${t.unread} unread` : ""}`);
  if (t.latest) parts.push(`latest ${t.latest.id} from ${addressText(t.latest.from)} ${t.latest.time ?? "(draft)"}`);
  if (t.participants.length) parts.push(`with ${t.participants.map(addressText).join(", ")}`);
  const line = parts.join(" · ");
  return t.match ? `${line}\n  matched ${t.match.field} of ${t.match.id}: ${headerValue(t.match.text)}` : line;
}

export function registerSearchTool(cache: SearchSupportCache = searchSupport): Register {
  return (server, deps) => {
    server.registerTool(
      "search_messages",
      {
        title: "Search fmsg messages",
        description:
          "Find conversations (threads) by the words in their messages: the topic, sender and recipient addresses, " +
          "attachment names and text body. Every word in query must match the start of a word in one message; case " +
          "and accents don't matter. Results are whole threads, newest activity first, each with its topic, message " +
          "and unread counts, participants, newest message, and where the words matched. An empty query lists threads " +
          "by the filters alone, such as unread_only. Use get_thread on a thread's root or match.id to read it.",
        inputSchema: z.strictObject({
          query: z.string().max(500).default("").describe("words to find; empty to list by the filters alone"),
          unread_only: z.boolean().default(false).describe("only threads with a message you haven't read"),
          with_attachments: z.boolean().default(false).describe("only threads with an attachment"),
          drafts_only: z.boolean().default(false).describe("only threads with one of your unsent drafts"),
          in_trash: z.boolean().default(false).describe("search the trash instead: threads with something you deleted"),
          sort: z.enum(["newest", "oldest"]).default("newest").describe("by each thread's newest message"),
          limit: z.number().int().min(1).max(50).default(10).describe("threads per page (at most 50)"),
          offset: z.number().int().min(0).default(0).describe("threads to skip; use next_offset for the next page"),
        }),
        outputSchema: outputObject({
          total: z.number().describe("matching threads over all pages"),
          next_offset: z.number().nullable().describe("offset for the next page, or null on the last"),
          terms: z.array(z.string()).describe("the words of query as matched"),
          threads: z.array(threadItem),
          ...untrustedNotice,
        }),
        annotations: READ_ONLY,
      },
      async ({ query, unread_only, with_attachments, drafts_only, in_trash, sort, limit, offset }, ctx) =>
        withCaller(deps, ctx, async (caller, signal) => {
          let result: SearchResult;
          try {
            result = await caller.client.search({
              q: query, sort, files: with_attachments, unread: unread_only, drafts: drafts_only, trash: in_trash, limit, offset,
            }, signal);
          } catch (error) {
            if (error instanceof FmsgHttpError && [404, 405, 501].includes(error.status)) {
              cache.remember(caller.client.apiUrl, false);
              return { content: [{ type: "text", text: "This fmsg host doesn't support search. Use list_messages and list_sent to find a thread by its topic, then get_thread." }], isError: true };
            }
            if (error instanceof FmsgHttpError && error.status === 503) {
              return { content: [{ type: "text", text: "The search took too long. Try more specific or fewer common words." }], isError: true };
            }
            throw error;
          }
          const threads = summarizeThreads(result, caller.address);
          const structured = { total: result.total, next_offset: result.next_offset, terms: result.terms, threads, ...UNTRUSTED };
          const what = query.trim() ? `matching ${JSON.stringify(query.trim())}` : "";
          if (!threads.length) return ok(`No threads ${what || "match those filters"}${offset ? ` at offset ${offset}` : ""}.`, structured);
          const head = `${result.total} thread${result.total === 1 ? "" : "s"} ${what}`.trim() +
            ` (showing ${offset + 1}–${offset + threads.length}${result.next_offset !== null ? `; next_offset ${result.next_offset}` : ""}):`;
          return ok(messageData(`${head}\n${threads.map(threadLine).join("\n")}`), structured);
        }),
    );
  };
}
