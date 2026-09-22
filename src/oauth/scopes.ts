export const READ_SCOPE = "fmsg:read";
export const WRITE_SCOPE = "fmsg:write";
export const MESSAGING_SCOPES = [READ_SCOPE, WRITE_SCOPE];

// Explicit tool classification, tested against the registered surface. Tools
// that read before writing request both scopes in one challenge.
export const TOOL_SCOPES: Record<string, string[]> = {
  whoami: [READ_SCOPE], resolve_address: [READ_SCOPE],
  list_messages: [READ_SCOPE], list_sent: [READ_SCOPE], get_message: [READ_SCOPE],
  get_thread: [READ_SCOPE], delivery_status: [READ_SCOPE], download_attachment: [READ_SCOPE],
  save_attachment: [READ_SCOPE], get_attachment_download_url: [READ_SCOPE], wait_for_message: [READ_SCOPE],
  send_message: [WRITE_SCOPE], reply: MESSAGING_SCOPES,
  mark_read: [WRITE_SCOPE], add_recipients: [WRITE_SCOPE], react: [WRITE_SCOPE],
};

export function parseScopes(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  if (value !== "" && !/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/u.test(value)) return undefined;
  return [...new Set(value.split(" ").filter(Boolean))];
}

export function requestScopes(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const request = body as { method?: unknown; params?: { name?: unknown } };
  if (request.method === "tools/call") {
    const name = request.params?.name;
    // Unknown tools remain the SDK's method/parameter error, never a callable surface.
    return typeof name === "string" && Object.hasOwn(TOOL_SCOPES, name) ? TOOL_SCOPES[name]! : [];
  }
  return request.method === "resources/read" ? [READ_SCOPE] : [];
}
