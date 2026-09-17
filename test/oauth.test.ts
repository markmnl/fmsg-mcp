import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHttpServer, type HttpServerHandle } from "../src/http.js";
import { OAuthIssuer } from "../src/oauth/issuer.js";
import { OAuthCallerProvider } from "../src/oauth/provider.js";
import { loadOAuthConfig } from "../src/oauth/config.js";
import { TOOL_SCOPES } from "../src/oauth/scopes.js";
import { waitForMessage } from "../src/wait.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { FakeOAuthServer } from "./fake-oauth-server.js";
import { ALICE, BOB, call, configFor, structured } from "./helpers.js";

describe("HTTP OAuth", () => {
  let api: FakeFmsgServer;
  let idp: FakeOAuthServer;
  let http: HttpServerHandle;
  let base: string;
  let issuer: OAuthIssuer;
  let provider: OAuthCallerProvider;
  let logs: string[];
  const clients: Client[] = [];
  beforeEach(async () => {
    api = new FakeFmsgServer(); await api.start();
    idp = new FakeOAuthServer(api); await idp.start();
    logs = [];
    const config = { ...configFor(api, "http"), oauth: idp.config };
    http = createHttpServer(config, line => logs.push(line));
    provider = http.provider as OAuthCallerProvider;
    issuer = provider.issuer;
    await new Promise<void>(resolve => http.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(clients.splice(0).map(client => client.close()));
    await http.close(); await idp.stop(); await api.stop();
  });
  async function post(token?: string, method = "tools/list", params: unknown = {}, extra: Record<string, string> = {}) {
    return fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  }
  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "oauth-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  }

  it("serves exact configured protected-resource metadata at root and resource paths", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toMatchObject({ resource: idp.config.resourceUrl, authorization_servers: [idp.config.issuerUrl],
        scopes_supported: ["fmsg:read", "fmsg:write"], bearer_methods_supported: ["header"] });
    }
    for (const token of [undefined, "fmsgk_alice_secret", "invalid"]) {
      const response = await post(token);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"');
      await response.body?.cancel();
    }
    expect(idp.requests).toHaveLength(0);
  });

  it("validates signed JWTs using the discovered OAuth JWKS and caches discovery", async () => {
    const token = await idp.token();
    expect(await issuer.verify(token)).toMatchObject({ address: ALICE, scopes: ["fmsg:read", "fmsg:write"], clientId: "test-agent" });
    await issuer.verify(token);
    expect(idp.requests).toEqual(["/.well-known/oauth-authorization-server/oauth", "/oauth/jwks.json"]);
    expect(idp.exchanges).toHaveLength(0);
  });

  it("preserves queries on discovered token and JWKS endpoints", async () => {
    idp.discoveryOverride = { jwks_uri: `${idp.baseUrl}/oauth/jwks.json?tenant=example`, token_endpoint: `${idp.baseUrl}/oauth/token?tenant=example` };
    const client = await connect(await idp.token());
    expect(structured(await call(client, "whoami"))).toMatchObject({ address: ALICE });
    expect(idp.requests).toContain("/oauth/jwks.json?tenant=example");
    expect(idp.requests).toContain("/oauth/token?tenant=example");
  });

  it("rejects the wrong signature, type, key, issuer, audience, lifetime, address and scope", async () => {
    const other = await generateKeyPair("EdDSA");
    const bad = [
      await idp.token({}, {}, other.privateKey), await idp.token({}, { typ: "JWT" }), await idp.token({}, { kid: "api-key" }),
      await idp.token({ iss: "https://foreign.example.com/oauth" }), await idp.token({ aud: idp.config.exchangeAudience }),
      await idp.token({ aud: [idp.config.resourceUrl, "owner"] }), await idp.token({ aud: `${idp.config.resourceUrl}/` }),
      await idp.token({ exp: 1 }), await idp.token({ exp: undefined }), await idp.token({ nbf: Date.now() / 1000 + 60 }),
      await idp.token({ sub: "account-id" }), await idp.token({ scope: ["fmsg:read"] }),
      await idp.token({ scope: "fmsg:read\nfmsg:write" }),
      `${Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt", kid: idp.kid })).toString("base64url")}.e30.`,
    ];
    for (const token of bad) {
      const response = await post(token);
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(token);
    }
    expect(idp.exchanges).toHaveLength(0);
    expect(api.requests).toHaveLength(0);
    expect(idp.requests).not.toContain("/.well-known/jwks.json");
  });

  it("fails closed on mismatched discovery and insecure endpoints without exposing secrets", async () => {
    idp.discoveryOverride = { issuer: "https://foreign.example.com" };
    const token = await idp.token();
    const response = await post(token);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(token);
    expect(logs.join()).toContain("operator action required");
    expect(logs.join()).not.toContain(idp.config.clientSecret);
    idp.discoveryOverride = { token_endpoint: "http://external.example.com/token" };
    expect((await post(token)).status).toBe(500);
    expect(api.requests).toHaveLength(0);
  });

  it("refreshes the discovered keys on an unknown kid after the fetch cooldown", async () => {
    await issuer.verify(await idp.token());
    idp.keys = await generateKeyPair("EdDSA");
    idp.kid = "rotated-oauth-key";
    const token = await idp.token({}, { jku: "https://untrusted.example.com/keys" });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6000);
    try { expect(await issuer.verify(token)).toMatchObject({ address: ALICE }); }
    finally { clock.mockRestore(); }
    expect(idp.requests).toEqual(["/.well-known/oauth-authorization-server/oauth", "/oauth/jwks.json", "/oauth/jwks.json"]);
  });

  it("does not let method headers or JSON batches bypass scope checks", async () => {
    const token = await idp.token({ scope: "fmsg:read" });
    const spoofed = await post(token, "tools/call", { name: "send_message", arguments: { to: [BOB], topic: "x", body: "x" } },
      { "mcp-method": "tools/list", "mcp-name": "whoami" });
    expect(spoofed.status).toBe(403);
    const batch = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message" } }]) });
    expect(batch.status).toBe(400);
    expect(idp.exchanges).toHaveLength(0);
    expect(api.requests).toHaveLength(0);
  });

  it("accepts the configured public origin behind a proxy and exposes auth challenges to allowed browsers", async () => {
    const origin = new URL(idp.config.resourceUrl).origin;
    const response = await post(undefined, "tools/list", {}, { origin });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
    expect((await post(undefined, "tools/list", {}, { origin: "https://untrusted.example.com" })).status).toBe(403);
  });

  it("classifies every HTTP tool and blocks insufficient scope before token exchange", async () => {
    const client = await connect(await idp.token({ scope: "" }));
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      expect(Object.hasOwn(TOOL_SCOPES, tool.name)).toBe(true);
      const scopes = TOOL_SCOPES[tool.name]!;
      expect(scopes).toContain(tool.annotations?.readOnlyHint ? "fmsg:read" : "fmsg:write");
      const token = await idp.token({ scope: tool.annotations?.readOnlyHint ? "fmsg:write" : "fmsg:read" });
      const response = await post(token, "tools/call", { name: tool.name, arguments: {} });
      expect(response.status, tool.name).toBe(403);
      expect(response.headers.get("www-authenticate")).toContain(`scope="${scopes.join(" ")}"`);
      await response.body?.cancel();
    }
    const resource = await post(await idp.token({ scope: "fmsg:write" }), "resources/read", { uri: "fmsg://message/1" });
    expect(resource.status).toBe(403);
    expect(idp.exchanges).toHaveLength(0);
    expect(api.requests).toHaveLength(0);
  });

  it("exchanges using Basic and form fields, never forwarding the incoming token or act-as", async () => {
    const token = await idp.token();
    const client = await connect(token);
    expect(client.getInstructions()).toContain(ALICE);
    expect(structured(await call(client, "whoami"))).toMatchObject({ address: ALICE, transport: "http" });
    expect((await call(client, "send_message", { to: [BOB], topic: "Hello", body: "hello" })).isError).toBeFalsy();
    expect((await call(client, "list_messages")).isError).toBeFalsy();
    expect(idp.exchanges).toHaveLength(1);
    const exchange = idp.exchanges[0]!;
    expect(Object.fromEntries(exchange.form)).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token", subject_token: token,
      audience: idp.config.exchangeAudience, scope: "fmsg:read fmsg:write" });
    expect(api.requests.length).toBeGreaterThan(1);
    for (const req of api.requests) {
      expect(req.authorization).toBe(`Bearer ${exchange.token}`);
      expect(req.actAs).toBeUndefined();
      expect(req.path).not.toBe("/fmsg/token");
    }
  });

  it("isolates caches per incoming token even for the same address", async () => {
    const tokens = [await idp.token(), await idp.token(), await idp.token({ sub: BOB })];
    const connected = await Promise.all(tokens.map(connect));
    const identities = await Promise.all(connected.map(client => call(client, "whoami")));
    expect(identities.map(result => structured<{ address: string }>(result).address)).toEqual([ALICE, ALICE, BOB]);
    expect(new Set(idp.exchanges.map(entry => entry.token)).size).toBe(3);
    expect(idp.exchanges.map(entry => entry.form.get("subject_token")).sort()).toEqual(tokens.sort());
    await Promise.all(connected.map(client => call(client, "list_messages")));
    expect(idp.exchanges).toHaveLength(3);
  });

  it.each([["invalid_grant", 401], ["invalid_client", 500], ["invalid_target", 500], ["temporarily_unavailable", 503]] as const)(
    "maps exchange %s to HTTP %i without exposing IdP error descriptions", async (code, status) => {
      idp.exchangeError = code;
      const token = await idp.token();
      const response = await post(token, "tools/call", { name: "list_messages" });
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).not.toContain(token); expect(text).not.toContain(idp.config.clientSecret);
      expect(logs.join()).not.toContain(token); expect(logs.join()).not.toContain(idp.config.clientSecret);
      if (status === 401) expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
      if (status === 500) expect(logs.join()).toContain("operator action required");
      expect(api.requests).toHaveLength(0);
    },
  );

  it("caps cache expiry by response, JWT, subject and five minutes", async () => {
    idp.exchangeTtl = 900;
    const token = await idp.token({ exp: Date.now() / 1000 + 1800 });
    const identity = await issuer.verify(token);
    const before = Date.now();
    const exchanged = await issuer.exchange(token, identity, new AbortController().signal);
    expect(exchanged.expiresAtMs).toBeGreaterThan(before + 290_000);
    expect(exchanged.expiresAtMs).toBeLessThanOrEqual(Date.now() + 300_000);
    idp.responseOverride = { expires_in: 20 };
    expect((await issuer.exchange(token, identity, new AbortController().signal)).expiresAtMs).toBeLessThanOrEqual(Date.now() + 20_000);
    idp.responseOverride = {};
    idp.exchangedClaims = { exp: Date.now() / 1000 + 10 };
    expect((await issuer.exchange(token, identity, new AbortController().signal)).expiresAtMs).toBeLessThanOrEqual(Date.now() + 10_000);
    idp.exchangedClaims = {};
    const short = await idp.token({ exp: Date.now() / 1000 + 5 });
    const shortIdentity = await issuer.verify(short);
    expect((await issuer.exchange(short, shortIdentity, new AbortController().signal)).expiresAtMs).toBeLessThanOrEqual(shortIdentity.expiresAtMs);
  });

  it("refuses exchange contract violations before making a Web API call", async () => {
    const token = await idp.token(); const identity = await issuer.verify(token);
    for (const override of [{ refresh_token: "not-allowed" }, { access_token: token }, { expires_in: 0 }, { scope: "owner" }]) {
      idp.responseOverride = override;
      await expect(issuer.exchange(token, identity, new AbortController().signal)).rejects.toMatchObject({ status: 500 });
    }
    idp.responseOverride = {};
    for (const claims of [{ aud: "owner" }, { aud: [idp.config.exchangeAudience, "owner"] }, { sub: BOB }, { scope: "owner" }]) {
      idp.exchangedClaims = claims;
      await expect(issuer.exchange(token, identity, new AbortController().signal)).rejects.toMatchObject({ status: 500 });
    }
    expect(api.requests).toHaveLength(0);
  });

  it("returns upstream insufficient-scope challenges and does not retry 403", async () => {
    const token = await idp.token();
    api.failNext = { match: /^GET \/fmsg$/u, status: 403, error: "route unavailable", challenge: 'Bearer error="insufficient_scope"' };
    const response = await post(token, "tools/call", { name: "list_messages" });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(idp.exchanges).toHaveLength(1);
    expect(api.requests).toHaveLength(1);
  });

  it("re-exchanges after upstream 401 and returns 401 if the grant was revoked", async () => {
    const token = await idp.token();
    const client = await connect(token);
    await call(client, "list_messages");
    idp.revoked.add(token);
    api.rejectNextProtected = true;
    const response = await post(token, "tools/call", { name: "list_messages" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(idp.exchanges).toHaveLength(2);
  });

  it("renews an expiring socket and catches up within the same wait", async () => {
    idp.exchangeTtl = 0.8;
    const token = await idp.token();
    const client = await connect(token);
    const waiting = call(client, "wait_for_message", { after_id: "0", timeout_seconds: 5, settle_seconds: 0, include_thread: false });
    await vi.waitFor(() => expect(api.connectedSockets(ALICE)).toBe(1));
    let id = "";
    idp.onExchange = async () => {
      // Arrives during credential exchange, without a socket announcement.
      id = api.seed({ from: BOB, to: [ALICE], data: "across renewal" }).id;
    };
    const result = structured<{ after_id: string; messages: unknown[]; transport: string }>(await waiting);
    expect(result).toMatchObject({ after_id: id, transport: "websocket" });
    expect(result.messages).toHaveLength(1);
    expect(idp.exchanges.length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(() => expect(api.connectedSockets(ALICE)).toBe(0));
    const sockets = api.requests.filter(req => req.path === "/fmsg/ws");
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sockets.map(req => req.authorization)).size).toBeGreaterThanOrEqual(2);
  });

  it("stops a wait when renewal reports revocation and releases the socket", async () => {
    idp.exchangeTtl = 0.5;
    const token = await idp.token();
    const auth = await provider.verifyAccessToken(token);
    const caller = await provider.forRequest(auth);
    try {
      const waiting = waitForMessage(caller.client, ALICE, { afterId: "0", timeoutMs: 5000, settleMs: 0 });
      const rejected = expect(waiting).rejects.toMatchObject({ status: 401 });
      await vi.waitFor(() => expect(api.connectedSockets(ALICE)).toBe(1));
      idp.revoked.add(token);
      await rejected;
      await vi.waitFor(() => expect(api.connectedSockets(ALICE)).toBe(0));
    } finally { provider.release(auth); }
  });

  it("returns 401 when the incoming token expires during a wait before streaming begins", async () => {
    const token = await idp.token({ exp: Date.now() / 1000 + 1 });
    const response = await post(token, "tools/call", { name: "wait_for_message", arguments: { after_id: "0", timeout_seconds: 5 } });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
    expect(idp.exchanges).toHaveLength(1);
    await vi.waitFor(() => expect(api.connectedSockets(ALICE)).toBe(0));
  });

  it("finishes an already streaming wait with an auth error and challenges the next call", async () => {
    // Accelerate only the wait's progress interval; network and token clocks stay real.
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) =>
      interval(fn, ms === 20_000 ? 50 : ms, ...args)) as typeof setInterval);
    idp.exchangeTtl = 0.5;
    const token = await idp.token();
    const response = await post(token, "tools/call", { name: "wait_for_message",
      arguments: { after_id: "0", timeout_seconds: 5 }, _meta: { progressToken: "waiting" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    idp.revoked.add(token);
    const events = await response.text();
    expect(events).toContain("notifications/progress");
    expect(events).toContain("refreshed or reconnected");
    expect(events).not.toContain(token);
    const next = await post(token, "tools/call", { name: "list_messages" });
    expect(next.status).toBe(401);
    expect(await next.json()).toMatchObject({ error: "invalid_token" });
    await vi.waitFor(() => expect(api.connectedSockets(ALICE)).toBe(0));
  });

  it("cancels a wait during exchange and does not open a late socket", async () => {
    const auth = await provider.verifyAccessToken(await idp.token());
    const caller = await provider.forRequest(auth);
    const controller = new AbortController();
    let release!: () => void;
    idp.onExchange = () => new Promise<void>(resolve => { release = resolve; });
    try {
      const waiting = waitForMessage(caller.client, ALICE, { afterId: "0", timeoutMs: 5000, settleMs: 0 }, controller.signal);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      controller.abort();
      expect(await waiting).toMatchObject({ note: "cancelled" });
      release();
      await vi.waitFor(() => expect(idp.exchanges[0]?.token).toBeTypeOf("string"));
      expect(api.connectedSockets(ALICE)).toBe(0);
    } finally { release?.(); provider.release(auth); }
  });
});

describe("OAuth configuration", () => {
  const env = { FMSG_MCP_AUTH_MODE: "oauth", FMSG_MCP_OAUTH_RESOURCE_URL: "https://mcp.example.com/mcp",
    FMSG_MCP_OAUTH_ISSUER_URL: "https://idp.example.com/oauth", FMSG_MCP_OAUTH_CLIENT_ID: "mcp",
    FMSG_MCP_OAUTH_CLIENT_SECRET: "secret", FMSG_MCP_OAUTH_EXCHANGE_AUDIENCE: "fmsg-webapi" };
  it("keeps API keys the default and requires explicit complete HTTP OAuth configuration", () => {
    expect(loadOAuthConfig({}, "http")).toBeUndefined();
    expect(loadOAuthConfig(env, "http")).toMatchObject({ addressClaim: "sub", exchangeAudience: "fmsg-webapi" });
    expect(() => loadOAuthConfig(env, "stdio")).toThrow("requires HTTP");
    expect(() => loadOAuthConfig({ ...env, FMSG_MCP_AUTH_MODE: "api-key" }, "http")).toThrow("Set FMSG_MCP_AUTH_MODE");
    for (const key of Object.keys(env).filter(key => key !== "FMSG_MCP_AUTH_MODE")) {
      expect(() => loadOAuthConfig({ ...env, [key]: "" }, "http")).toThrow("required");
    }
    for (const url of ["http://mcp.example.com/mcp", "https://user:secret@mcp.example.com/mcp", "https://mcp.example.com/mcp?x=1", "https://mcp.example.com/mcp#fragment"]) {
      expect(() => loadOAuthConfig({ ...env, FMSG_MCP_OAUTH_RESOURCE_URL: url }, "http")).toThrow();
    }
  });
});
