import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FmsgClient, openFmsgWebSocket, type AccessToken, type TokenProvider, type TokenProviderRequest } from "../src/client/index.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB } from "./helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("caller-bound token providers", () => {
  let fake: FakeFmsgServer;
  let clients: FmsgClient[];
  let nextToken: number;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    clients = [];
    nextToken = 0;
  });
  afterEach(async () => {
    clients.forEach(client => client.close());
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fake.stop();
  });

  function issue(address = ALICE, ttlMs = 3_600_000): AccessToken {
    const token = { accessToken: `fixture-token-${++nextToken}`, address, expiresAtMs: Date.now() + ttlMs };
    fake.providerTokens.set(token.accessToken, token);
    return token;
  }

  function provider(address = ALICE, ttlMs = 3_600_000) {
    return { getToken: vi.fn(async (_request: TokenProviderRequest) => issue(address, ttlMs)), close: vi.fn() } satisfies TokenProvider;
  }

  function client(credentials: string | TokenProvider, options: ConstructorParameters<typeof FmsgClient>[2] = {}) {
    const result = new FmsgClient(fake.baseUrl, credentials, options);
    clients.push(result);
    return result;
  }

  it("authenticates HTTP and WebSockets with provider tokens and isolates two callers", async () => {
    const alice = client(provider());
    const bob = client(provider(BOB));
    const privateMessage = fake.seed({ from: BOB, to: [ALICE], data: "alice inbox" });
    const [aliceInbox, bobInbox] = await Promise.all([alice.listInbox(), bob.listInbox()]);
    expect(aliceInbox.map(m => m.id)).toEqual([privateMessage.id]);
    expect(bobInbox).toEqual([]);
    const secret = fake.seed({ from: ALICE, to: [ALICE], data: "alice only" });
    await expect(bob.getMessage(secret.id)).rejects.toMatchObject({ status: 404 });
    const sent = await alice.send({ to: [BOB], body: "hello" });
    expect(fake.messages.get(sent.id)?.from).toBe(ALICE);
    const a = await openFmsgWebSocket(alice);
    const b = await openFmsgWebSocket(bob);
    try {
      await Promise.all([once(a, "open"), once(b, "open")]);
      expect(fake.connectedSockets(ALICE)).toBe(1);
      expect(fake.connectedSockets(BOB)).toBe(1);
      const received = once(b, "message");
      fake.push(fake.seed({ from: ALICE, to: [BOB], data: "bob event" }));
      expect(String((await received)[0])).toContain("bob event");
    } finally { a.close(); b.close(); }
    expect(fake.requests.some(r => r.path === "/fmsg/token")).toBe(false);
  });

  it("renews short-lived tokens once per batch without refreshing on every call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const source = provider(ALICE, 60_000);
    const c = client(source);
    const first = await c.getToken();
    await c.listInbox();
    await c.address();
    expect(source.getToken).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 30_001);
    const refreshed = await Promise.all(Array.from({ length: 10 }, () => c.getToken()));
    expect(source.getToken).toHaveBeenCalledTimes(2);
    expect(new Set(refreshed.map(t => t.accessToken)).size).toBe(1);
    expect(refreshed[0]!.accessToken).not.toBe(first.accessToken);
    expect(source.getToken.mock.calls[1]![0]).toMatchObject({ apiUrl: fake.baseUrl, forceRefresh: false });
    vi.setSystemTime(Date.now() + 60_001);
    await c.listInbox();
    expect(source.getToken).toHaveBeenCalledTimes(3);
  });

  it("keeps API-key renewal ahead of expiry and does not extend JWT expiry from response metadata", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const c = client("fmsgk_alice_secret");
    const first = await c.getToken();
    vi.setSystemTime(first.expiresAtMs - 300_001);
    await c.getToken();
    expect(fake.requests.filter(r => r.path === "/fmsg/token")).toHaveLength(1);
    vi.setSystemTime(first.expiresAtMs - 299_999);
    await c.getToken();
    expect(fake.requests.filter(r => r.path === "/fmsg/token")).toHaveLength(2);
    const payload = Buffer.from(JSON.stringify({ sub: ALICE, exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    const bounded = client("fmsgk_alice_secret", { fetch: async () => Response.json({
      access_token: `e30.${payload}.signature`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), expires_in: 3600,
    }) });
    expect((await bounded.getToken()).expiresAtMs).toBe((Math.floor(Date.now() / 1000) + 60) * 1000);
  });

  it("shares forced renewal and reuses it when an older request returns a late 401", async () => {
    const source = provider();
    const oldResponse = deferred<Response>();
    const requests: string[] = [];
    let oldToken: string;
    const c = client(source, { fetch: async (_url, init) => {
      const bearer = new Headers(init?.headers).get("authorization")!;
      requests.push(bearer);
      if (bearer === `Bearer ${oldToken}`) {
        return requests.length === 1 ? oldResponse.promise : Response.json({ error: "expired" }, { status: 401 });
      }
      return Response.json([]);
    } });
    oldToken = (await c.getToken()).accessToken;
    const slow = c.listInbox();
    const fast = Array.from({ length: 5 }, () => c.listInbox());
    await Promise.all(fast);
    expect(source.getToken).toHaveBeenCalledTimes(2);
    expect(source.getToken.mock.calls[1]![0].forceRefresh).toBe(true);
    oldResponse.resolve(Response.json({ error: "old token" }, { status: 401 }));
    await slow;
    expect(source.getToken).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(12);
  });

  it("retries a protected 401 only once, and never renews for an upstream 403", async () => {
    const source = provider();
    let status = 401;
    const fetch = vi.fn(async () => Response.json({ error: "upstream denial" }, { status }));
    const c = client(source, { fetch });
    await expect(c.listInbox()).rejects.toMatchObject({ status: 401, message: "upstream denial" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(source.getToken).toHaveBeenCalledTimes(2);
    status = 403;
    await expect(c.listInbox()).rejects.toMatchObject({ status: 403 });
    expect(source.getToken).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to a cached token after renewal fails, and can recover", async () => {
    const source = provider();
    const c = client(source);
    await c.getToken();
    source.getToken.mockRejectedValueOnce(new Error("connection revoked"));
    fake.rejectNextProtected = true;
    await expect(c.listInbox()).rejects.toThrow("connection revoked");
    expect(fake.requests.filter(r => r.path === "/fmsg")).toHaveLength(1);
    await expect(c.listInbox()).resolves.toEqual([]);
    expect(source.getToken).toHaveBeenCalledTimes(3);
  });

  it("pins the address through failed renewals and snapshots provider output", async () => {
    const supplied = { ...issue() };
    const source = provider();
    source.getToken.mockResolvedValueOnce(supplied);
    const c = client(source);
    const first = await c.getToken();
    supplied.address = BOB;
    supplied.accessToken = "changed";
    expect(first.address).toBe(ALICE);
    expect(first.accessToken).not.toBe("changed");
    expect(Object.isFrozen(first)).toBe(true);
    source.getToken.mockResolvedValueOnce(issue(BOB));
    await expect(c.getToken(true)).rejects.toThrow("changed the authenticated address");
    source.getToken.mockResolvedValueOnce(issue("@Alice@example.com"));
    await expect(c.listInbox()).rejects.toThrow("changed the authenticated address");
    expect(fake.requests).toHaveLength(0);
    await expect(c.address()).resolves.toBe(ALICE);
  });

  it.each([
    { accessToken: "" }, { accessToken: "secret\r\ninjection" }, { accessToken: "fmsgk_wrong_credential" },
    { address: "invalid" }, { expiresAtMs: Number.NaN }, { expiresAtMs: Number.POSITIVE_INFINITY }, { expiresAtMs: 0 },
  ])("rejects invalid provider output before contacting the Web API: %j", async override => {
    const c = client({ getToken: async () => ({ ...issue(), ...override }) });
    await expect(c.listInbox()).rejects.toThrow(/token provider/u);
    expect(fake.requests).toHaveLength(0);
  });

  it("cancels one token waiter without cancelling another, then aborts when no callers remain", async () => {
    const source = provider();
    const held = deferred<AccessToken>();
    source.getToken.mockImplementationOnce(() => held.promise);
    const c = client(source);
    const a = new AbortController();
    const b = new AbortController();
    const one = expect(c.listInbox(20, 0, a.signal)).rejects.toMatchObject({ name: "AbortError" });
    const two = expect(c.listInbox(20, 0, b.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(source.getToken).toHaveBeenCalledOnce());
    const renewalSignal = source.getToken.mock.calls[0]![0].signal;
    a.abort();
    await one;
    expect(renewalSignal.aborted).toBe(false);
    b.abort();
    await two;
    expect(renewalSignal.aborted).toBe(true);
    const fresh = await c.getToken();
    held.resolve(issue(BOB)); // Late completion must not replace the recovered token.
    await Promise.resolve();
    expect((await c.getToken()).accessToken).toBe(fresh.accessToken);
    expect(fake.requests).toHaveLength(0);
  });

  it("lets an uncancelled waiter complete a shared renewal", async () => {
    const source = provider();
    const held = deferred<AccessToken>();
    source.getToken.mockImplementationOnce(() => held.promise);
    const c = client(source);
    const abort = new AbortController();
    const cancelled = expect(c.getToken(false, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    const remaining = c.listInbox();
    await vi.waitFor(() => expect(source.getToken).toHaveBeenCalledOnce());
    abort.abort();
    await cancelled;
    held.resolve(issue());
    await expect(remaining).resolves.toEqual([]);
    expect(source.getToken).toHaveBeenCalledOnce();
  });

  it.each(["close", "timeout"])("settles waiting callers on %s even if a provider ignores its signal", async reason => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const source = provider();
    const held = deferred<AccessToken>();
    source.getToken.mockImplementationOnce(() => held.promise);
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const c = client(source, { timeoutMs: 100 });
    const pending = expect(c.getToken()).rejects.toMatchObject({ name: reason === "close" ? "AbortError" : "TimeoutError" });
    await vi.advanceTimersByTimeAsync(0);
    if (reason === "close") c.close();
    else await vi.advanceTimersByTimeAsync(101);
    await pending;
    expect(source.getToken.mock.calls[0]![0].signal.aborted).toBe(true);
    // Other tests may leave fetch keep-alive timers; check this acquisition timer.
    expect(clearSpy).toHaveBeenCalledWith(timerSpy.mock.results[0]!.value);
    c.close();
    c.close();
    expect(source.close).toHaveBeenCalledOnce();
    held.resolve(issue());
    await expect(c.getToken()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not start token acquisition for cancelled sends or WebSockets", async () => {
    const source = provider();
    const c = client(source);
    await expect(c.send({ to: [BOB], body: "cancelled", signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    await expect(openFmsgWebSocket(c, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(source.getToken).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
  });

  it("cancels token acquisition before opening a WebSocket", async () => {
    const source = provider();
    source.getToken.mockImplementationOnce(() => new Promise(() => undefined));
    const c = client(source);
    const abort = new AbortController();
    const opening = expect(openFmsgWebSocket(c, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(source.getToken).toHaveBeenCalledOnce());
    abort.abort();
    await opening;
    expect(source.getToken.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(fake.connectedSockets(ALICE)).toBe(0);
  });
});
