import { type McpServer, ResourceTemplate, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { normalizeMessageId } from "./client/message-id.js";
import { callerFor } from "./context.js";
import { describeError } from "./errors.js";
import { redactSecrets } from "./client/redact.js";
import { messageData, messageHeader } from "./render.js";
import { assembleThread, renderThread } from "./thread.js";
import type { ToolDeps } from "./tools/common.js";

async function resourceResult<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw new ProtocolError(
      error instanceof ProtocolError ? error.code : ProtocolErrorCode.InternalError,
      describeError(error),
    );
  }
}

export function registerResources(server: McpServer, deps: ToolDeps): void {
  server.registerResource(
    "message",
    new ResourceTemplate("fmsg://message/{id}", { list: undefined }),
    { title: "fmsg message", description: "One fmsg message with headers and body", mimeType: "text/markdown" },
    async (uri, { id }, ctx) => resourceResult(async () => {
      let mid: string;
      try {
        mid = normalizeMessageId(String(id));
      } catch {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, redactSecrets(`invalid fmsg message id "${String(id)}"`).text);
      }
      const caller = await callerFor(deps.provider, ctx);
      const message = await caller.client.getMessage(mid, ctx.mcpReq.signal);
      const text = await caller.client.getText(message, ctx.mcpReq.signal);
      const body = text === null ? `[non-text body: ${message.type ?? "?"}, ${message.size ?? 0} bytes]` : text;
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: messageData(`${messageHeader(message)}\n\n${body}`) }] };
    }),
  );

  server.registerResource(
    "thread",
    new ResourceTemplate("fmsg://thread/{id}", { list: undefined }),
    { title: "fmsg thread", description: "The lineage of messages from the thread root to the given message", mimeType: "text/markdown" },
    async (uri, { id }, ctx) => resourceResult(async () => {
      let mid: string;
      try {
        mid = normalizeMessageId(String(id));
      } catch {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, redactSecrets(`invalid fmsg message id "${String(id)}"`).text);
      }
      const caller = await callerFor(deps.provider, ctx);
      const thread = await assembleThread(caller.client, caller.address, mid, {
        maxMessages: 100,
        maxBodyBytesPerMessage: 65_536,
        maxTotalBytes: 1_048_576,
      }, ctx.mcpReq.signal);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: renderThread(thread) }] };
    }),
  );
}
