import WebSocket from "ws";
import type { FmsgClient } from "./client.js";
import { normalizeMessageId, parseFmsgJson } from "./message-id.js";
import type { FmsgMessage, WsEvent } from "./types.js";

/** Open the event WebSocket, authenticating with the bearer JWT in the header. */
export async function openFmsgWebSocket(client: FmsgClient): Promise<WebSocket> {
  const token = await client.getToken();
  const url = new URL(client.apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/fmsg/ws`;
  url.search = "";
  return new WebSocket(url, { headers: { authorization: `Bearer ${token.accessToken}` } });
}

export function parseWsEvent(raw: WebSocket.RawData): WsEvent | undefined {
  try {
    const parsed = parseFmsgJson<{ type?: unknown; data?: FmsgMessage }>(raw.toString());
    if (!parsed || typeof parsed.type !== "string") return undefined;
    const data = parsed.data && typeof parsed.data === "object" && parsed.data.id !== undefined
      ? { ...parsed.data, id: normalizeMessageId(parsed.data.id), reaction: parsed.data.reaction ?? null, reactions: parsed.data.reactions ?? [] }
      : undefined;
    return data ? { type: parsed.type, data } : { type: parsed.type };
  } catch {
    return undefined;
  }
}
