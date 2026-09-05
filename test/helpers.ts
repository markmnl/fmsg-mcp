import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthInfo, CallToolResult, McpHttpHandler } from "@modelcontextprotocol/server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { FmsgClient } from "../src/client/client.js";
import { loadConfig, type Config, type Transport } from "../src/config.js";
import { StaticCallerProvider, type CallerProvider } from "../src/context.js";
import { createFmsgMcpServer } from "../src/server.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";

export const ALICE = "@alice@example.com";
export const BOB = "@bob@example.net";
export const CAROL = "@carol@example.org";

export function configFor(fake: FakeFmsgServer, transport: Transport = "stdio", extra: Record<string, string> = {}): Config {
  return loadConfig(
    { FMSG_API_URL: fake.baseUrl, ...(transport === "stdio" ? { FMSG_API_KEY: "fmsgk_alice_secret" } : {}), ...extra },
    transport,
  );
}

export type Harness = { client: Client; close: () => Promise<void>; fmsg: FmsgClient };

/** stdio-shaped: one server instance pinned to one in-memory connection. */
export async function connectInMemory(fake: FakeFmsgServer, apiKey = "fmsgk_alice_secret", extra: Record<string, string> = {}): Promise<Harness> {
  const config = configFor(fake, "stdio", extra);
  const fmsg = new FmsgClient(fake.baseUrl, apiKey);
  const provider = new StaticCallerProvider(fmsg);
  const server = createFmsgMcpServer(provider, config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    fmsg,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** HTTP-shaped: per-request factory driven through handler.fetch with a fixed authInfo. */
export async function connectHttpShaped(
  fake: FakeFmsgServer,
  provider: CallerProvider,
  authInfo: AuthInfo | undefined,
  config = configFor(fake, "http"),
): Promise<Harness & { handler: McpHttpHandler }> {
  const handler = createMcpHandler(({ authInfo: a }) =>
    createFmsgMcpServer(provider, config, a?.clientId ? { address: a.clientId } : {}),
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init), { authInfo }),
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  return {
    client,
    handler,
    fmsg: new FmsgClient(fake.baseUrl, "fmsgk_alice_secret"),
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return client.callTool({ name, arguments: args });
}

export function text(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export function structured<T = Record<string, unknown>>(result: CallToolResult): T {
  if (result.isError) throw new Error(`tool returned error: ${text(result)}`);
  return result.structuredContent as T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
