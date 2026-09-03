import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ApiKeyCallerProvider } from "../src/auth.js";
import { createHttpServer, type HttpServerHandle } from "../src/http.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, call, configFor, connectHttpShaped, structured, text } from "./helpers.js";

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
      expect(text(saved)).toContain("stdio");
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
    }
  });
});
