import * as z from "zod/v4";
import { messageLine } from "../render.js";
import { READ_ONLY, type Register, deliveryItem, deliveryOf, messageItem, ok, toItem, withCaller } from "./common.js";

const pageInput = {
  limit: z.number().int().min(1).max(100).default(20).describe("page size (host maximum 100)"),
  offset: z.number().int().min(0).default(0).describe("number of newest messages to skip"),
  include_reactions: z.boolean().default(false).describe("also list reaction messages (normally hidden)"),
};

export const registerListTools: Register = (server, deps) => {
  server.registerTool(
    "list_messages",
    {
      title: "List inbox",
      description:
        "List messages received by this address, newest first. Each item carries the id, sender, recipients, topic, " +
        "time, read state, flags, size, attachment names and a short preview. Reaction messages are hidden unless " +
        "include_reactions is true. Use get_message for a full body and get_thread for the conversation around a message.",
      inputSchema: z.object({
        ...pageInput,
        unread_only: z.boolean().default(false).describe("keep only unread messages from the fetched page"),
      }),
      outputSchema: z.object({
        messages: z.array(messageItem),
        count: z.number(),
        offset: z.number(),
        next_offset: z.number().nullable().describe("offset for the next page, or null when this page was short"),
      }),
      annotations: READ_ONLY,
    },
    async ({ limit, offset, include_reactions, unread_only }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const page = await caller.client.listInbox(limit, offset, signal);
        const shown = page.filter((m) => (include_reactions || m.reaction === null || m.reaction === undefined) && (!unread_only || m.read === false));
        const structured = {
          messages: shown.map((m) => toItem(m, caller.address)),
          count: shown.length,
          offset,
          next_offset: page.length === limit ? offset + limit : null,
        };
        const text = shown.length
          ? `${shown.length} message${shown.length === 1 ? "" : "s"} (offset ${offset}):\n${shown.map((m) => messageLine(m, caller.address)).join("\n")}`
          : `No ${unread_only ? "unread " : ""}messages at offset ${offset}.`;
        return ok(text, structured);
      }),
  );

  server.registerTool(
    "list_sent",
    {
      title: "List sent messages",
      description:
        "List messages sent by this address (including unsent drafts, shown with time null), newest first, with " +
        "per-recipient delivery state. Use delivery_status for one message's detail.",
      inputSchema: z.object(pageInput),
      outputSchema: z.object({
        messages: z.array(messageItem.extend({ delivery: z.array(deliveryItem) })),
        count: z.number(),
        offset: z.number(),
        next_offset: z.number().nullable(),
      }),
      annotations: READ_ONLY,
    },
    async ({ limit, offset, include_reactions }, ctx) =>
      withCaller(deps, ctx, async (caller, signal) => {
        const page = await caller.client.listSent(limit, offset, signal);
        const shown = page.filter((m) => include_reactions || m.reaction === null || m.reaction === undefined);
        const structured = {
          messages: shown.map((m) => ({ ...toItem(m, caller.address), delivery: deliveryOf(m) })),
          count: shown.length,
          offset,
          next_offset: page.length === limit ? offset + limit : null,
        };
        const text = shown.length
          ? `${shown.length} sent message${shown.length === 1 ? "" : "s"} (offset ${offset}):\n${shown
              .map((m) => {
                const d = deliveryOf(m);
                const summary = d.length ? ` · delivered ${d.filter((x) => x.status === "delivered").length}/${d.length}` : "";
                return `${messageLine(m, caller.address)}${summary}`;
              })
              .join("\n")}`
          : `No sent messages at offset ${offset}.`;
        return ok(text, structured);
      }),
  );
};
