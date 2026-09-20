import { request } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ApiKeyCallerProvider } from "../src/auth.js";
import { createHttpServer, type HttpServerHandle } from "../src/http.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, CAROL, call, configFor, connectHttpShaped, structured, text } from "./helpers.js";

describe("HTTP transport", () => {
  let fake: FakeFmsgServer;
  let http: HttpServerHandle;
  let base: string;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    http = createHttpServer(configFor(fake, "http"), () => undefined);
    await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await http.close();
    await fake.stop();
  });

  async function connect(apiKey: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    });
    const client = new Client({ name: "http-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    return client;
  }

  it("answers /healthz and rejects unknown paths", async () => {
    const ok = await fetch(`${base}/healthz`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, name: "fmsg-mcp" });
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it("shuts down connections opened without an HTTP request", async () => {
    // Fetch pools may open a replacement connection after a cancelled download.
    const socket = createConnection({ host: "127.0.0.1", port: (http.server.address() as AddressInfo).port });
    await once(socket, "connect");
    const closing = http.close();
    try {
      await vi.waitFor(() => expect(socket.destroyed).toBe(true));
      await closing;
    } finally { socket.destroy(); await closing; }
  });

  it("requires a bearer fmsg API key", async () => {
    const none = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    const bad = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fmsgk_wrong" },
      body: "{}",
    });
    expect(bad.status).toBe(401);
    const notKey = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sometoken" },
      body: "{}",
    });
    expect(notKey.status).toBe(401);
  });

  it("releases the caller lease when middleware rejects expired authentication", async () => {
    const originalVerify = http.provider.verifyAccessToken.bind(http.provider);
    const verify = vi.spyOn(http.provider, "verifyAccessToken").mockImplementation(async token => ({
      ...await originalVerify(token), expiresAt: Math.floor(Date.now() / 1000) - 1,
    }));
    try {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fmsgk_alice_secret" },
        body: "{}",
      });
      expect(response.status).toBe(401);
      await response.body?.cancel();
      const auth = await verify.mock.results[0]!.value;
      await vi.waitFor(async () => {
        await expect(http.provider.forRequest(auth)).rejects.toThrow("not authenticated");
      });
    } finally { verify.mockRestore(); }
  });

  it("rejects a foreign Host header on a loopback bind", async () => {
    // fetch() forbids overriding Host, so use node:http directly.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fmsgk_alice_secret", host: "evil.example" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });

  it("requires explicit hosts for a public bind and rejects invalid origins independently", async () => {
    const publicConfig = configFor(fake, "http", { FMSG_MCP_HOST: "0.0.0.0" });
    expect(() => createHttpServer(publicConfig)).toThrow("FMSG_MCP_ALLOWED_HOSTS");
    for (const origin of ["https://evil.example", "null", "http://localhost.evil.example:6274", "not a URL"]) {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(403);
    }
    expect(fake.requests.filter(r => r.path === "/fmsg/token")).toHaveLength(0);
  });

  it("allows loopback browser development on other ports while preserving authentication", async () => {
    for (const origin of ["http://localhost:6274", "http://127.0.0.1:6274", "http://[::1]:6274"]) {
      const headers = { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" };
      expect((await fetch(`${base}/mcp`, { method: "OPTIONS", headers })).status).toBe(204);
      expect((await fetch(`${base}/mcp`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    }
  });

  it("answers allowed CORS preflights without credentials while keeping actual requests authenticated", async () => {
    await http.close();
    http = createHttpServer(configFor(fake, "http", { FMSG_MCP_ALLOWED_ORIGINS: "https://app.example.com" }), () => undefined);
    await new Promise<void>(resolve => http.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
    const headers = { origin: "https://app.example.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,mcp-method,mcp-name,mcp-protocol-version" };
    const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS", headers });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(headers.origin);
    const actual = await fetch(`${base}/mcp`, { method: "POST", headers: { origin: headers.origin, "content-type": "application/json" }, body: "{}" });
    expect(actual.status).toBe(401);
    expect(actual.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
    for (const origin of ["http://app.example.com", "https://app.example.com:444", "https://app.example.com.evil.example", "http://localhost:6274"]) {
      expect((await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { ...headers, origin } })).status).toBe(403);
    }
    expect((await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { ...headers, "access-control-request-headers": "x-unapproved" } })).status).toBe(403);
  });

  it("preserves upstream visibility and denial for tools, resources and revoked keys", async () => {
    const alice = await connect("fmsgk_alice_secret");
    const bob = await connect("fmsgk_bob_secret");
    const privateMessage = fake.seed({ from: CAROL, to: [ALICE], data: "private payload", attachments: [{ filename: "private.txt", data: Buffer.from("private bytes") }] });
    try {
      const reads = await Promise.all([
        call(alice, "get_message", { id: privateMessage.id }),
        call(bob, "get_message", { id: privateMessage.id }),
        call(bob, "get_thread", { id: privateMessage.id }),
        call(bob, "download_attachment", { id: privateMessage.id, filename: "private.txt" }),
        call(bob, "reply", { id: privateMessage.id, body: "unauthorized reply" }),
      ]);
      expect(reads[0]?.isError).toBeFalsy();
      for (const denied of reads.slice(1)) {
        expect(denied?.isError).toBe(true);
        expect(JSON.stringify(denied)).not.toContain("private payload");
        expect(JSON.stringify(denied)).not.toContain("private bytes");
      }
      for (const kind of ["message", "thread"]) await expect(bob.readResource({ uri: `fmsg://${kind}/${privateMessage.id}` })).rejects.toThrow();
      expect(fake.requests.filter(r => r.method === "POST" && r.path === "/fmsg")).toHaveLength(0);
      fake.apiKeys.delete("fmsgk_alice_secret");
      const revoked = await call(alice, "list_messages");
      expect(revoked.isError).toBe(true);
      expect(JSON.stringify(revoked)).not.toContain("private payload");
      expect(http.provider.size).toBe(1);
      expect((await call(bob, "list_messages")).isError).toBeFalsy();
    } finally { await alice.close(); await bob.close(); }
  });

  it("serves each caller as their own address and isolates keys", async () => {
    const alice = await connect("fmsgk_alice_secret");
    const bob = await connect("fmsgk_bob_secret");
    try {
      expect(structured<{ address: string; transport: string }>(await call(alice, "whoami"))).toMatchObject({ address: ALICE, transport: "http" });
      expect(structured<{ address: string }>(await call(bob, "whoami")).address).toBe(BOB);
      fake.seed({ from: BOB, to: [ALICE], topic: "for alice", data: "hi alice" });
      expect(structured<{ count: number }>(await call(alice, "list_messages")).count).toBe(1);
      expect(structured<{ count: number }>(await call(bob, "list_messages")).count).toBe(0);
      expect(fake.requests.filter((r) => r.path === "/fmsg/token")).toHaveLength(2);
      expect(http.provider.size).toBe(2);
      const saved = await call(alice, "download_attachment", { id: "1", filename: "x", save_to: "/tmp/x" });
      expect(saved.isError).toBe(true);
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it("works through the in-process handler with a fixed authInfo", async () => {
    const provider = new ApiKeyCallerProvider(configFor(fake, "http"));
    const auth = await provider.verifyAccessToken("fmsgk_carol_secret");
    expect(auth.clientId).toBe("@carol@example.org");
    const h = await connectHttpShaped(fake, provider, auth);
    try {
      expect(structured<{ address: string }>(await call(h.client, "whoami")).address).toBe("@carol@example.org");
      expect(h.client.getInstructions()).toContain("you are acting as @carol@example.org");
    } finally {
      await h.close();
    }
    const anon = await connectHttpShaped(fake, provider, undefined);
    try {
      const r = await call(anon.client, "whoami");
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("not authenticated");
    } finally {
      await anon.close();
      provider.close();
    }
  });

  it("closes upstream wait sockets when an HTTP caller cancels", async () => {
    const alice = await connect("fmsgk_alice_secret");
    const controller = new AbortController();
    try {
      const waiting = alice.callTool({ name: "wait_for_message", arguments: { after_id: "0", timeout_seconds: 30 } }, { signal: controller.signal });
      const cancelled = expect(waiting).rejects.toThrow();
      await vi.waitFor(() => expect(fake.connectedSockets(ALICE)).toBe(1));
      controller.abort();
      await cancelled;
      await vi.waitFor(() => expect(fake.connectedSockets(ALICE)).toBe(0));
    } finally { controller.abort(); await alice.close(); }
  });

  it("rechecks upstream authorization before returning content announced on an existing socket", async () => {
    const alice = await connect("fmsgk_alice_secret");
    try {
      const waiting = call(alice, "wait_for_message", { after_id: "0", timeout_seconds: 5, settle_seconds: 0, include_thread: false });
      await vi.waitFor(() => expect(fake.connectedSockets(ALICE)).toBe(1));
      fake.apiKeys.delete("fmsgk_alice_secret");
      // The fake deliberately leaves existing sockets open on revocation.
      fake.push(fake.seed({ from: BOB, to: [ALICE], topic: "private after revocation", data: "must not be returned" }));
      const result = await waiting;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("must not be returned");
      expect(JSON.stringify(result)).not.toContain("private after revocation");
      expect(http.provider.size).toBe(0);
      await vi.waitFor(() => expect(fake.connectedSockets(ALICE)).toBe(0));
    } finally { await alice.close(); }
  });
});
