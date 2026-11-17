import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { request, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHttpServer, sendWebResponse, type HttpServerHandle } from "../src/http.js";
import { loadConfig } from "../src/config.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, CAROL, call, configFor, connectHttpShaped, connectInMemory, structured } from "./helpers.js";
import { StaticCallerProvider } from "../src/context.js";
import { FmsgClient } from "../src/client/client.js";

describe("authenticated binary attachment downloads", () => {
  let api: FakeFmsgServer;
  let http: HttpServerHandle;
  let base: string;
  const clients: Client[] = [];
  const headers = { authorization: "Bearer fmsgk_alice_secret" };
  beforeEach(async () => {
    api = new FakeFmsgServer(); await api.start();
    http = createHttpServer(configFor(api, "http", { FMSG_MCP_PUBLIC_URL: "https://mcp.example.com/mcp" }), () => undefined);
    await new Promise<void>(resolve => http.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(c => c.close()));
    await http.close(); await api.stop();
  });
  async function connect(key = "fmsgk_alice_secret") {
    const client = new Client({ name: "download-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}`, "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" } },
    }));
    return client;
  }
  function seed(filename = "data.bin", data = Buffer.from([0, 255, 128, 10]), type = "application/octet-stream") {
    return api.seed({ from: CAROL, to: [ALICE], attachments: [{ filename, data, type }] });
  }
  const path = (id: string, filename = "data.bin") => `/mcp/attachments/${id}/${encodeURIComponent(filename)}`;

  it("returns a credential-free configured resource link and streams large original bytes", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const filename = 'résumé #1 "final".bin';
    const message = seed(filename, bytes);
    const client = await connect();
    const advertised = (await client.listTools()).tools.find(t => t.name === "get_attachment_download_url");
    expect(advertised?.annotations?.readOnlyHint).toBe(true);
    const result = await call(client, "get_attachment_download_url", { id: message.id, filename });
    const data = structured<{ download_url: string; size: number }>(result);
    expect(data).toMatchObject({ id: message.id, size: bytes.length, authentication: "bearer" });
    expect(data.download_url).toBe(`https://mcp.example.com${path(message.id, filename)}`);
    expect(result.content.map(c => c.type)).toEqual(["text", "resource_link"]);
    expect(JSON.stringify(result)).not.toMatch(/fmsgk_|evil\.example|base64|blob/);
    expect(api.requests.some(r => r.path.includes("/attach/"))).toBe(false);
    const response = await fetch(`${base}${new URL(data.download_url).pathname}`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%231%20%22final%22.bin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("requires authentication on each fetch and preserves upstream visibility and revocation", async () => {
    const message = seed();
    const url = `${base}${path(message.id)}`;
    for (const authorization of [undefined, "Bearer fmsgk_wrong"]) {
      const response = await fetch(url, { headers: authorization ? { authorization } : {} });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
      await response.body?.cancel();
    }
    expect((await call(await connect("fmsgk_bob_secret"), "get_attachment_download_url", { id: message.id, filename: "data.bin" })).isError).toBe(true);
    const other = await fetch(url, { headers: { authorization: "Bearer fmsgk_bob_secret" } });
    expect(other.status).toBe(404);
    expect(await other.text()).toContain("message not found");
    const alice = await connect();
    expect((await call(alice, "get_attachment_download_url", { id: message.id, filename: "missing.bin" })).isError).toBe(true);
    const first = await fetch(url, { headers });
    expect(first.status).toBe(200); await first.body?.cancel();
    api.apiKeys.delete("fmsgk_alice_secret");
    const revoked = await fetch(url, { headers });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain("fmsgk_");
    expect(http.provider.size).toBe(1); // Only Bob remains cached.
  });

  it("checks Host/Origin and supports authenticated browser downloads and preflights", async () => {
    const message = seed("page.html", Buffer.from("<script>alert(1)</script>"), "text/html");
    const url = `${base}${path(message.id, "page.html")}`;
    // fetch ignores a custom Host header; use the Node HTTP client for this check.
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = request(url, { headers: { ...headers, host: "evil.example" } }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject); req.end();
    });
    expect(badHost).toBe(403);
    expect((await fetch(url, { headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
    expect(api.requests).toHaveLength(0);
    const origin = "https://mcp.example.com";
    const preflight = await fetch(url, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET");
    expect((await fetch(url, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } })).status).toBe(403);
    const response = await fetch(url, { headers: { ...headers, origin } });
    expect(response.headers.get("access-control-expose-headers")).toContain("Content-Disposition");
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(await response.text()).toBe("<script>alert(1)</script>");
  });

  it("rejects invalid paths, token queries and unsupported methods before contacting the API", async () => {
    for (const suffix of ["0/a", "9223372036854775808/a", "1/%ZZ", "1/%2fetc", "1/%5Cetc", "1/a%0D%0Aheader", "1/a/b"]) {
      expect((await fetch(`${base}/mcp/attachments/${suffix}`, { headers })).status).toBe(400);
    }
    const url = `${base}${path("123")}`;
    expect((await fetch(`${url}?access_token=fmsgk_alice_secret`, { headers })).status).toBe(400);
    for (const method of ["POST", "DELETE", "HEAD"]) {
      const result = await fetch(url, { method, headers });
      expect(result.status).toBe(405);
      expect(result.headers.get("allow")).toBe("GET, OPTIONS");
    }
    expect(api.requests).toHaveLength(0);
  });

  it("preserves upstream errors with secret redaction, then serves the file after recovery", async () => {
    const message = seed();
    api.failNext = { match: /\/attach\//u, status: 413, error: "host policy detail fmsgk_do_not_leak" };
    const response = await fetch(`${base}${path(message.id)}`, { headers });
    expect(response.status).toBe(413);
    const error = await response.text();
    expect(error).toContain("host policy detail");
    expect(error).not.toContain("fmsgk_do_not_leak");
    expect(Buffer.from(await (await fetch(`${base}${path(message.id)}`, { headers })).arrayBuffer())).toEqual(Buffer.from([0, 255, 128, 10]));
  });

  it("streams before completion and cancels the upstream request on client disconnect", async () => {
    const message = seed();
    let closed = false;
    api.attachmentResponse = (_req, res) => {
      res.once("close", () => { closed = true; });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(Buffer.from([0, 255, 128])); // Deliberately never finish.
    };
    const controller = new AbortController();
    try {
      const response = await fetch(`${base}${path(message.id)}`, { headers, signal: controller.signal });
      const reader = response.body!.getReader();
      expect((await reader.read()).value).toEqual(new Uint8Array([0, 255, 128]));
      controller.abort();
      await expect(reader.read()).rejects.toThrow();
      await vi.waitFor(() => expect(closed).toBe(true));
    } finally { controller.abort(); }
  });

  it("fails an interrupted transfer instead of completing a truncated file or appending an error", async () => {
    const message = seed();
    let upstream!: ServerResponse;
    api.attachmentResponse = (_req, res) => {
      upstream = res;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(Buffer.from([0, 255, 128]));
    };
    const response = await fetch(`${base}${path(message.id)}`, { headers });
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([0, 255, 128]));
    upstream.destroy();
    await expect(reader.read()).rejects.toThrow();
  });

  it("advertises links only for HTTP deployments with a public URL", async () => {
    const local = await connectInMemory(api, "fmsgk_alice_secret", { FMSG_MCP_PUBLIC_URL: "https://mcp.example.com/mcp" });
    try { expect((await local.client.listTools()).tools.some(t => t.name === "get_attachment_download_url")).toBe(false); }
    finally { await local.close(); }
    const provider = new StaticCallerProvider(new FmsgClient(api.baseUrl, "fmsgk_alice_secret"));
    const remote = await connectHttpShaped(api, provider, undefined);
    try { expect((await remote.client.listTools()).tools.some(t => t.name === "get_attachment_download_url")).toBe(false); }
    finally { await remote.close(); provider.close(); }
    expect(configFor(api, "http").http.publicUrl).toBeUndefined();
    for (const value of ["http://mcp.example.com/mcp", "https://user:pass@example.com/mcp", "https://example.com/mcp?token=x", "https://example.com/mcp#x"]) {
      expect(() => loadConfig({ FMSG_API_URL: api.baseUrl, FMSG_MCP_PUBLIC_URL: value }, "http")).toThrow("FMSG_MCP_PUBLIC_URL");
    }
    const oauthEnv = { FMSG_API_URL: api.baseUrl, FMSG_MCP_AUTH_MODE: "oauth", FMSG_MCP_OAUTH_RESOURCE_URL: "https://mcp.example.com/custom/mcp",
      FMSG_MCP_OAUTH_ISSUER_URL: "https://idp.example.com/oauth", FMSG_MCP_OAUTH_CLIENT_ID: "mcp", FMSG_MCP_OAUTH_CLIENT_SECRET: "secret", FMSG_MCP_OAUTH_EXCHANGE_AUDIENCE: "fmsg-webapi" };
    expect(loadConfig(oauthEnv, "http").http.publicUrl).toBe(oauthEnv.FMSG_MCP_OAUTH_RESOURCE_URL);
    expect(() => loadConfig({ ...oauthEnv, FMSG_MCP_PUBLIC_URL: "https://elsewhere.example/mcp" }, "http")).toThrow("must match");
  });
});

it("pauses upstream reads under downstream backpressure and cancels on disconnect", async () => {
  let pulls = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array([1])); }, cancel }, { highWaterMark: 0 });
  const response = Object.assign(new EventEmitter(), {
    headersSent: false, destroyed: false,
    writeHead() { this.headersSent = true; },
    write: vi.fn(() => false), end: vi.fn(),
    destroy() { response.destroyed = true; response.emit("close"); },
  });
  const pending = sendWebResponse(response as unknown as ServerResponse, new Response(stream));
  await vi.waitFor(() => expect(response.write).toHaveBeenCalledTimes(1));
  expect(pulls).toBe(1);
  response.destroy();
  await pending;
  expect(cancel).toHaveBeenCalled();
  expect(pulls).toBe(1);
});
