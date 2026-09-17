import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FmsgClient, FmsgHttpError } from "../src/client/client.js";
import { parseFmsgJson, stringifyWithIds, normalizeMessageId } from "../src/client/message-id.js";
import { redactSecrets } from "../src/client/redact.js";
import { fence } from "../src/render.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB } from "./helpers.js";

describe("message ids", () => {
  it("keeps int64 ids exact through parse and stringify", () => {
    const big = "9223372036854775806";
    const parsed = parseFmsgJson<{ id: string; pid: string; nested: { batch_id: string } }>(`{"id":${big},"pid":${big},"nested":{"batch_id":${big}}}`);
    expect(parsed.id).toBe(big);
    expect(parsed.pid).toBe(big);
    expect(parsed.nested.batch_id).toBe(big);
    expect(stringifyWithIds({ a: 1 }, { pid: big })).toBe(`{"a":1},"pid":${big}}`.replace("},", ","));
    expect(() => normalizeMessageId("0")).toThrow();
    expect(() => normalizeMessageId("abc")).toThrow();
  });
});

describe("content safety", () => {
  it("replaces keys and JWTs and counts them", () => {
    const r = redactSecrets("key fmsgk_abcdefghijkl_0123456789 and token eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl end");
    expect(r.text).not.toContain("fmsgk_abc");
    expect(r.text).not.toContain("eyJ");
    expect(r.count).toBe(2);
  });

  it("frames large text with many backtick runs without exceeding the argument limit", () => {
    const body = "text`".repeat(150000) + "\n````";
    const framed = fence(body);
    expect(framed.slice(0, 6)).toBe("`````\n");
    expect(framed.slice(-6)).toBe("\n`````");
    expect(framed.slice(6, -6) === body).toBe(true);
  });
});

describe("FmsgClient", () => {
  let fake: FakeFmsgServer;
  let client: FmsgClient;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    client = new FmsgClient(fake.baseUrl, "fmsgk_alice_secret");
  });
  afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); client.close(); await fake.stop(); });

  // Keep deadline tests independent of socket keep-alive timers and real time.
  function tokenResponse(): Promise<Response> {
    const payload = Buffer.from(JSON.stringify({ sub: ALICE, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    return Promise.resolve(Response.json({ access_token: `e30.${payload}.signature`, expires_in: 3600 }));
  }

  function useDeadlineClock(): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Native AbortSignal.timeout does not use the fake clock. Include it so the
    // old whole-body timeout would abort a progressing stream in this regression.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(new DOMException("timed out", "TimeoutError")), ms).unref();
      return abort.signal;
    });
  }

  function controlledDownload() {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let requestSignal!: AbortSignal;
    const cancelled = vi.fn();
    client = new FmsgClient(fake.baseUrl, "fmsgk_alice_secret", {
      timeoutMs: 100,
      fetch: (url, init) => {
        if (String(url).endsWith("/token")) return tokenResponse();
        requestSignal = init!.signal!;
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
            requestSignal.addEventListener("abort", () => controller.error(requestSignal.reason), { once: true });
          },
          cancel: cancelled,
        }), { headers: { "content-type": "application/octet-stream" } }));
      },
    });
    return { get source() { return source; }, get signal() { return requestSignal; }, cancelled };
  }

  it("allows a progressing attachment to outlive the request timeout", async () => {
    const upstream = controlledDownload();
    await client.address();
    useDeadlineClock();
    const { stream } = await client.streamAttachment("1", "slow.bin");
    const reader = stream.getReader();
    for (let i = 0; i < 4; i++) {
      const reading = reader.read();
      await vi.advanceTimersByTimeAsync(80);
      upstream.source.enqueue(new Uint8Array([i]));
      expect((await reading).value).toEqual(new Uint8Array([i]));
    }
    upstream.source.close();
    expect((await reader.read()).done).toBe(true);
    expect(upstream.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    reader.releaseLock();
  });

  it.each(["idle", "caller", "close"])("stops an attachment stream on %s and releases its timer", async (reason) => {
    const upstream = controlledDownload();
    await client.address();
    useDeadlineClock();
    const abort = new AbortController();
    const { stream } = await client.streamAttachment("1", "slow.bin", abort.signal);
    const reader = stream.getReader();
    const rejected = expect(reader.read()).rejects.toMatchObject({ name: reason === "idle" ? "TimeoutError" : "AbortError" });
    if (reason === "idle") await vi.advanceTimersByTimeAsync(101);
    else if (reason === "caller") abort.abort();
    else client.close();
    await rejected;
    if (reason === "idle") expect(upstream.cancelled).toHaveBeenCalledOnce();
    else expect(upstream.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    reader.releaseLock();
  });

  it("still times out while waiting for attachment response headers", async () => {
    client = new FmsgClient(fake.baseUrl, "fmsgk_alice_secret", {
      timeoutMs: 100,
      fetch: (url, init) => String(url).endsWith("/token") ? tokenResponse() : new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }),
    });
    await client.address();
    useDeadlineClock();
    const rejected = expect(client.streamAttachment("1", "slow.bin")).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exchanges the key once and caches the token", async () => {
    expect(await client.address()).toBe(ALICE);
    await client.listInbox();
    await client.listInbox();
    expect(fake.requests.filter((r) => r.path === "/fmsg/token")).toHaveLength(1);
  });

  it("refreshes and retries once on 401", async () => {
    await client.address();
    fake.rejectNextProtected = true;
    const items = await client.listInbox();
    expect(items).toEqual([]);
    expect(fake.requests.filter((r) => r.path === "/fmsg/token")).toHaveLength(2);
  });

  it("surfaces host errors with status and text", async () => {
    await expect(client.getMessage("42")).rejects.toMatchObject({ status: 404, name: "FmsgHttpError" });
    const bad = new FmsgClient(fake.baseUrl, "fmsgk_nope");
    await expect(bad.address()).rejects.toBeInstanceOf(FmsgHttpError);
  });

  it("rejects attachment path components before making an upstream request", async () => {
    for (const filename of ["", ".", "..", "../note.txt", "folder/note.txt", "folder\\note.txt", "bad\u0000name"]) {
      await expect(client.streamAttachment("1", filename)).rejects.toThrow("filename without directory components");
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("bounds proxy error previews while streaming and preserves host policy JSON", async () => {
    let chunks = 0;
    let cancelled = false;
    const proxyClient = new FmsgClient(fake.baseUrl, "fmsgk_alice_secret", {
      fetch: (url, init) => String(url).endsWith("/token") ? fetch(url, init) : Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        pull(controller) { chunks++; controller.enqueue(Buffer.from("<html>proxy unavailable</html>".repeat(100))); },
        cancel() { cancelled = true; },
      }), { status: 502, headers: { "content-type": "text/html" } })),
    });
    try {
      const error = await proxyClient.listInbox().catch(error => error as FmsgHttpError);
      expect(error).toBeInstanceOf(FmsgHttpError);
      expect((error as FmsgHttpError).message.length).toBeLessThan(2200);
      expect((error as FmsgHttpError).message).toContain("truncated");
      expect(chunks).toBeLessThan(5);
      expect(cancelled).toBe(true);
      const detail = "host acceptance explanation ".repeat(200);
      fake.failNext = { match: /^GET \/fmsg$/u, status: 413, error: detail, code: "host_limit" };
      await expect(client.listInbox()).rejects.toMatchObject({ status: 413, message: detail, code: "host_limit" });
      fake.failNext = { match: /^GET \/fmsg$/u, status: 503, error: detail };
      const jsonError = await client.listInbox().catch(error => error as FmsgHttpError);
      expect(jsonError).toBeInstanceOf(FmsgHttpError);
      expect((jsonError as FmsgHttpError).message.length).toBeLessThan(2200);
      expect((jsonError as FmsgHttpError).message).toContain("truncated");
    } finally { proxyClient.close(); }
  });

  it("lists the inbox with exact big ids and fetches full text beyond short_text", async () => {
    const big = "9223372036854775806";
    const long = "x".repeat(2000);
    fake.seed({ id: big, from: BOB, to: [ALICE], topic: "big", data: long });
    const [item] = await client.listInbox();
    expect(item!.id).toBe(big);
    expect(FmsgClient.shortTextIsComplete(item!)).toBe(false);
    expect(await client.getText(item!)).toBe(long);
    const short = fake.seed({ from: BOB, to: [ALICE], data: "hi" });
    const got = await client.getMessage(short.id);
    expect(got.id).toBe(short.id);
    expect(await client.getText(got)).toBe("hi");
    expect(fake.requests.filter((r) => r.path.endsWith("/data"))).toHaveLength(1);
  });

  it("sends draft → attach → send with the exact pid and rolls back on failure", async () => {
    const parent = fake.seed({ from: BOB, to: [ALICE], topic: "t", data: "parent" });
    const sent = await client.send({
      to: [BOB],
      pid: parent.id,
      body: "reply body",
      attachments: [{ filename: "a.txt", data: new TextEncoder().encode("hello"), contentType: "text/plain" }],
    });
    expect(sent.attachments).toEqual([{ filename: "a.txt", size: 5 }]);
    const draft = fake.requests.find((r) => r.method === "POST" && r.path === "/fmsg")!;
    expect(draft.rawBody).toContain(`"pid":${parent.id}`);
    expect((draft.body as { topic: string }).topic).toBe("");
    expect(fake.messages.get(sent.id)!.time).not.toBeNull();

    fake.failNext = { match: /POST .*\/attach$/u, status: 413, error: "attachment exceeds maximum size" };
    await expect(
      client.send({ to: [BOB], topic: "x", body: "b", attachments: [{ filename: "big.bin", data: new Uint8Array(10) }] }),
    ).rejects.toMatchObject({ status: 413 });
    const drafts = [...fake.messages.values()].filter((m) => m.from === ALICE && m.time === null);
    expect(drafts.every((d) => d.deleted)).toBe(true);
  });

  it("keeps the token's address case so from matches the authenticated user", async () => {
    const agent = new FmsgClient(fake.baseUrl, "fmsgk_agent_secret");
    expect(await agent.address()).toBe("@Alice_ChatGPT@example.com");
    const sent = await agent.send({ to: [BOB], topic: "case", body: "hi" });
    expect(fake.messages.get(sent.id)!.from).toBe("@Alice_ChatGPT@example.com");
  });

  it("refuses replies to terminal messages with the host's 409", async () => {
    const parent = fake.seed({ from: BOB, to: [ALICE], data: "x", terminal: true });
    await expect(client.send({ to: [BOB], pid: parent.id, body: "no" })).rejects.toMatchObject({ status: 409 });
  });

  it("loads thread messages, adds recipients, reacts and marks read", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "root", data: "first" });
    const reply = fake.seed({ from: ALICE, to: [BOB], pid: root.id, data: "second" });
    const thread = await client.getThreadMessages(reply.id);
    expect(thread.root_id).toBe(root.id);
    expect(thread.messages.map((m) => m.id)).toEqual([root.id, reply.id]);
    expect(thread.messages[0]!.body?.text).toBe("first");
    expect(await client.getThreadText(reply.id)).toContain("second");

    expect(await client.addRecipients(root.id, ["@carol@example.org"])).toEqual({ id: root.id, added: 1 });
    const reacted = await client.react(root.id, "👍");
    expect(reacted.id).not.toBeNull();
    const again = await client.getMessage(root.id);
    expect(again.reactions).toEqual([{ emoji: "👍", from: [ALICE] }]);
    expect(await client.react(root.id, null)).toMatchObject({ id: expect.any(String) });
    const read = await client.markRead(root.id);
    expect(read.time_read).not.toBeNull();
  });

  it("downloads attachments by name and by thread download path", async () => {
    const m = fake.seed({ from: BOB, to: [ALICE], data: "x", attachments: [{ filename: "img.png", data: Buffer.from([1, 2, 3]), type: "image/png" }] });
    const a = await client.downloadAttachment(m.id, "img.png");
    expect([...a.data]).toEqual([1, 2, 3]);
    expect(a.contentType).toBe("image/png");
    const viaPath = await client.downloadPath(`/fmsg/${m.id}/attach/img.png`);
    expect(viaPath.data.byteLength).toBe(3);
    await expect(client.downloadPath("http://evil/x")).rejects.toThrow();
  });
});
