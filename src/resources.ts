import { type McpServer, ResourceTemplate, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { normalizeMessageId } from "./client/message-id.js";
import { callerFor } from "./context.js";
import { DATA_NOT_INSTRUCTIONS, fence, messageHeader } from "./render.js";
import { assembleThread, renderThread } from "./thread.js";
import type { ToolDeps } from "./tools/common.js";

export function registerResources(server: McpServer, deps: ToolDeps): void {
  server.registerResource(
    "message",
    new ResourceTemplate("fmsg://message/{id}", { list: undefined }),
    { title: "fmsg message", description: "One fmsg message with headers and body", mimeType: "text/markdown" },
    async (uri, { id }, ctx) => {
      let mid: string;
      try {
        mid = normalizeMessageId(String(id));
      } catch {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `invalid fmsg message id "${String(id)}"`);
      }
      const caller = await callerFor(deps.provider, ctx);
      const message = await caller.client.getMessage(mid, ctx.mcpReq.signal);
      const text = await caller.client.getText(message, ctx.mcpReq.signal);
      const body = text === null ? `[non-text body: ${message.type ?? "?"}, ${message.size ?? 0} bytes]` : `${DATA_NOT_INSTRUCTIONS}\n\n${fence(text)}`;
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: `${messageHeader(message)}\n\n${body}` }] };
    },
  );

  server.registerResource(
    "thread",
    new ResourceTemplate("fmsg://thread/{id}", { list: undefined }),
    { title: "fmsg thread", description: "The lineage of messages from the thread root to the given message", mimeType: "text/markdown" },
    async (uri, { id }, ctx) => {
      let mid: string;
      try {
        mid = normalizeMessageId(String(id));
      } catch {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `invalid fmsg message id "${String(id)}"`);
      }
      const caller = await callerFor(deps.provider, ctx);
      const thread = await assembleThread(caller.client, caller.address, mid, {
        maxMessages: 100,
        maxBodyBytesPerMessage: 65_536,
        maxTotalBytes: 1_048_576,
      }, ctx.mcpReq.signal);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: renderThread(thread) }] };
    },
  );
}
