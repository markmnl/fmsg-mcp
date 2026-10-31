import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FmsgClient, FmsgHttpError } from "../src/client/client.js";
import { parseWsEvent } from "../src/client/ws.js";
import type { Caller } from "../src/context.js";
import { IndicatorRegistry } from "../src/indicators.js";
import { waitForMessage } from "../src/wait.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, CAROL, type Harness, call, connectHttpShaped, connectInMemory, sleep, structured, text } from "./helpers.js";
import { StaticCallerProvider } from "../src/context.js";

type Sent = { id: string; emoji: string; ttl: number };

/** A caller whose client records indicate calls; `fail` decides the outcome of each. */
function fakeCaller(fail: (sent: Sent) => unknown = () => undefined, address = ALICE): Caller & { sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    indicate: async (id: string, emoji: string, ttl: number) => {
      const entry = { id, emoji, ttl: emoji ? ttl : 0 };
      sent.push(entry);
      const error = fail(entry);
      if (error) throw error;
    },
  } as unknown as FmsgClient;
  return { client, address, tokenExpiresAt: async () => Date.now() + 3_600_000, sent };
}

describe("FmsgClient.indicate", () => {
  let fake: FakeFmsgServer;
  beforeEach(async () => { fake = new FakeFmsgServer(); await fake.start(); });
  afterEach(async () => fake.stop());

  it("posts the emoji and ttl, clears with an empty emoji, and surfaces a host without indicators", async () => {
    const m = fake.seed({ from: BOB, to: [ALICE], topic: "t", data: "x" });
    const client = new FmsgClient(fake.baseUrl, "fmsgk_alice_secret");
    await client.indicate(m.id, "⏳", 60);
    await client.indicate(m.id, "", 60);
    const posts = fake.requests.filter((r) => r.path === `/fmsg/${m.id}/indicate`);
    expect(posts.map((r) => [r.method, r.body])).toEqual([["POST", { emoji: "⏳", ttl: 60 }], ["POST", { emoji: "", ttl: 0 }]]);
    expect(fake.indicators).toEqual([{ id: m.id, from: ALICE, emoji: "⏳", ttl: 60 }, { id: m.id, from: ALICE, emoji: "", ttl: 0 }]);
    fake.indicatorsSupported = false;
    await expect(client.indicate(m.id, "⏳", 60)).rejects.toMatchObject({ status: 404 });
    client.close();
  });
});

describe("IndicatorRegistry timers", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends at once, refreshes at half its ttl (at most every 30 s) and clears after 5 minutes", async () => {
    const registry = new IndicatorRegistry();
    const caller = fakeCaller();
    await registry.indicate(caller, "7", "⏳", 60);
    expect(caller.sent).toEqual([{ id: "7", emoji: "⏳", ttl: 60 }]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(caller.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(caller.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(caller.sent.filter((s) => s.emoji === "⏳")).toHaveLength(10);
    expect(registry.active(caller)).toEqual(["7"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(caller.sent.at(-1)).toEqual({ id: "7", emoji: "", ttl: 0 });
    expect(caller.sent.filter((s) => s.emoji === "⏳")).toHaveLength(10);
    expect(registry.active(caller)).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(caller.sent).toHaveLength(11);
  });

  it("stops on reply in the thread, reaction, mark_read and close, clearing each once", async () => {
    const registry = new IndicatorRegistry();
    const caller = fakeCaller();
    await registry.indicate(caller, "10", "⏳", 60, "1");
    await registry.indicate(caller, "11", "⏳", 60, "1");
    await registry.indicate(caller, "20", "⏳", 60, "2");
    await registry.indicate(caller, "30", "⏳", 60);
    await registry.indicate(caller, "40", "⏳", 60);
    caller.sent.length = 0;

    registry.replied(caller, "12", "1");
    await vi.advanceTimersByTimeAsync(0);
    expect(caller.sent).toEqual([{ id: "10", emoji: "", ttl: 0 }, { id: "11", emoji: "", ttl: 0 }]);
    registry.handled(caller, ["20"]);
    registry.replied(caller, "30", null);
    await vi.advanceTimersByTimeAsync(0);
    expect(caller.sent.slice(2)).toEqual([{ id: "20", emoji: "", ttl: 0 }, { id: "30", emoji: "", ttl: 0 }]);
    expect(registry.active(caller)).toEqual(["40"]);

    registry.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(caller.sent.slice(4)).toEqual([{ id: "40", emoji: "", ttl: 0 }]);
    // Once closed, indicate still shows the emoji once but keeps nothing up.
    await registry.indicate(caller, "50", "⏳", 60);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(caller.sent.slice(5)).toEqual([{ id: "50", emoji: "⏳", ttl: 60 }]);
    expect(registry.active(caller)).toEqual([]);
  });

  it("keeps at most 10 per caller, clearing the oldest", async () => {
    const registry = new IndicatorRegistry();
    const caller = fakeCaller();
    for (let i = 1; i <= 11; i++) await registry.indicate(caller, String(i), "⏳", 60);
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.active(caller)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
    expect(caller.sent.filter((s) => s.emoji === "")).toEqual([{ id: "1", emoji: "", ttl: 0 }]);
    const other = fakeCaller(undefined, CAROL);
    await registry.indicate(other, "1", "⏳", 60);
    expect(registry.active(other)).toEqual(["1"]);
    registry.close();
  });

  it("a new emoji replaces the old and refreshes at half its ttl; clearing stops it without a second clear", async () => {
    const registry = new IndicatorRegistry();
    const caller = fakeCaller();
    await registry.indicate(caller, "9", "⏳", 60, "1");
    await registry.indicate(caller, "9", "✍️", 10);
    expect(caller.sent).toEqual([{ id: "9", emoji: "⏳", ttl: 60 }, { id: "9", emoji: "✍️", ttl: 10 }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(caller.sent.at(-1)).toEqual({ id: "9", emoji: "✍️", ttl: 10 });
    expect(caller.sent).toHaveLength(3);
    // The replacement keeps the thread root it was first set with.
    registry.replied(caller, "8", "1");
    await vi.advanceTimersByTimeAsync(0);
    expect(caller.sent.slice(3)).toEqual([{ id: "9", emoji: "", ttl: 0 }]);
    expect(registry.active(caller)).toEqual([]);

    await registry.indicate(caller, "9", "✍️", 10);
    await registry.indicate(caller, "9", "", 60);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(caller.sent.slice(4)).toEqual([{ id: "9", emoji: "✍️", ttl: 10 }, { id: "9", emoji: "", ttl: 0 }]);
    expect(registry.active(caller)).toEqual([]);
  });

  it("swallows refresh failures: keeps refreshing after transient ones, stops after a refusal or a missing route", async () => {
    const registry = new IndicatorRegistry();
    let transientSends = 0;
    const transient = fakeCaller(() => transientSends++ ? new FmsgHttpError("unavailable", 503, "POST", "/fmsg/1/indicate") : undefined);
    await registry.indicate(transient, "1", "⏳", 60);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transient.sent).toHaveLength(3);
    expect(registry.active(transient)).toEqual(["1"]);

    let olderSends = 0;
    const older = fakeCaller(() => olderSends++ ? new FmsgHttpError("not found", 404, "POST", "/fmsg/2/indicate") : undefined, BOB);
    await registry.indicate(older, "2", "⏳", 60);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(older.sent).toEqual([{ id: "2", emoji: "⏳", ttl: 60 }, { id: "2", emoji: "⏳", ttl: 60 }]);
    expect(registry.active(older)).toEqual([]);

    // The first send is the tool's own: its failure is returned and nothing is kept up.
    const throwing = fakeCaller(() => new Error("boom"), CAROL);
    await expect(registry.indicate(throwing, "3", "✍️", 30)).rejects.toThrow("boom");
    expect(registry.active(throwing)).toEqual([]);
    registry.close();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("never lets a clear overtake an earlier send", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    let sends = 0;
    const client = {
      indicate: async (_id: string, emoji: string) => {
        if (emoji && ++sends > 1) await gate;
        order.push(emoji || "clear");
      },
    } as unknown as FmsgClient;
    const caller: Caller = { client, address: ALICE, tokenExpiresAt: async () => 0 };
    const registry = new IndicatorRegistry();
    await registry.indicate(caller, "1", "⏳", 60);
    await vi.advanceTimersByTimeAsync(30_000);
    registry.handled(caller, ["1"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["⏳"]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["⏳", "⏳", "clear"]);
  });
});

describe("indicators through the tools", () => {
  let fake: FakeFmsgServer;
  let h: Harness;
  let registry: IndicatorRegistry;
  const caller = () => ({ client: h.fmsg, address: ALICE, tokenExpiresAt: async () => 0 });
  const indicated = (id: string) => fake.indicators.filter((i) => i.id === id).map((i) => i.emoji);

  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    registry = new IndicatorRegistry();
    h = await connectInMemory(fake, "fmsgk_alice_secret", {}, { indicators: registry });
  });
  afterEach(async () => {
    registry.close();
    await h.close();
    await fake.stop();
  });

  it("get_message and get_thread do not post an indicator", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "plans", data: "root" });
    const next = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "next" });
    structured(await call(h.client, "get_message", { id: root.id }));
    structured(await call(h.client, "get_message", { id: next.id }));
    structured(await call(h.client, "get_thread", { id: next.id }));
    await sleep(50);
    expect(fake.requests.filter((r) => r.path.endsWith("/indicate"))).toEqual([]);
    expect(fake.indicators).toEqual([]);
    expect(registry.active(caller())).toEqual([]);
  });

  it("reply anywhere in the thread, react and mark_read clear it", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "plans", data: "root" });
    const next = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "next" });
    const later = fake.seed({ from: BOB, to: [ALICE], pid: next.id, data: "later" });
    const other = fake.seed({ from: CAROL, to: [ALICE], topic: "other", data: "o" });
    const third = fake.seed({ from: CAROL, to: [ALICE], topic: "third", data: "t" });
    for (const id of [root.id, next.id, other.id, third.id]) structured(await call(h.client, "indicate", { id }));
    expect(fake.indicators).toHaveLength(4);

    structured(await call(h.client, "reply", { id: later.id, body: "on it" }));
    await vi.waitFor(() => expect(indicated(root.id)).toEqual(["⏳", ""]));
    expect(indicated(next.id)).toEqual(["⏳", ""]);
    structured(await call(h.client, "react", { id: other.id, emoji: "👍" }));
    structured(await call(h.client, "mark_read", { ids: [third.id] }));
    await vi.waitFor(() => expect(indicated(third.id)).toEqual(["⏳", ""]));
    expect(indicated(other.id)).toEqual(["⏳", ""]);
    expect(registry.active(caller())).toEqual([]);
  });

  it("indicate sets, refreshes and clears explicitly, validating its input", async () => {
    const m = fake.seed({ from: BOB, to: [ALICE], topic: "t", data: "x" });
    const set = structured<{ emoji: string; ttl: number; cleared: boolean }>(await call(h.client, "indicate", { id: m.id }));
    expect(set).toMatchObject({ id: m.id, emoji: "⏳", ttl: 60, cleared: false });
    expect(fake.indicators).toEqual([{ id: m.id, from: ALICE, emoji: "⏳", ttl: 60 }]);
    expect(registry.active(caller())).toEqual([m.id]);
    structured(await call(h.client, "indicate", { id: m.id, emoji: "✍️", ttl: 120 }));
    const cleared = structured<{ cleared: boolean; ttl: number }>(await call(h.client, "indicate", { id: m.id, emoji: "" }));
    expect(cleared).toMatchObject({ cleared: true, ttl: 0 });
    expect(fake.indicators.map((i) => i.emoji)).toEqual(["⏳", "✍️", ""]);
    expect(registry.active(caller())).toEqual([]);

    for (const args of [{ id: m.id, ttl: 0 }, { id: m.id, ttl: 121 }, { id: m.id, ttl: 1.5 }, { id: "abc" }, { id: m.id, extra: true }, { id: m.id, emoji: "x".repeat(33) }]) {
      expect((await call(h.client, "indicate", args)).isError, JSON.stringify(args)).toBe(true);
    }
    const terminal = fake.seed({ from: BOB, to: [ALICE], data: "👍", reaction: "👍", terminal: true, no_reply: true });
    const refused = await call(h.client, "indicate", { id: terminal.id });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("terminal");
    fake.indicatorsSupported = false;
    expect((await call(h.client, "indicate", { id: m.id })).isError).toBe(true);
    expect(registry.active(caller())).toEqual([]);
    const tool = (await h.client.listTools()).tools.find((t) => t.name === "indicate")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(tool.description).toContain("expires on its own");
    expect(h.client.getInstructions()).toContain("indicate can show the other participants a status such as ⏳");
    expect(h.client.getInstructions()).toContain("an empty emoji clears it");
  });
});

describe("indicator lifetime", () => {
  let fake: FakeFmsgServer;
  beforeEach(async () => { fake = new FakeFmsgServer(); await fake.start(); });
  afterEach(async () => fake.stop());

  it("a stdio-shaped server clears its indicators when the session closes", async () => {
    const h = await connectInMemory(fake);
    const m = fake.seed({ from: BOB, to: [ALICE], topic: "t", data: "x" });
    structured(await call(h.client, "indicate", { id: m.id }));
    expect(fake.indicators).toHaveLength(1);
    await h.close();
    await vi.waitFor(() => expect(fake.indicators.map((i) => i.emoji)).toEqual(["⏳", ""]));
  });

  it("a server clears its indicators on shutdown", async () => {
    const shutdown = new AbortController();
    const h = await connectInMemory(fake, "fmsgk_alice_secret", {}, { shutdown: shutdown.signal });
    const m = fake.seed({ from: BOB, to: [ALICE], topic: "t", data: "x" });
    structured(await call(h.client, "indicate", { id: m.id }));
    expect(fake.indicators).toHaveLength(1);
    shutdown.abort();
    await vi.waitFor(() => expect(fake.indicators.map((i) => i.emoji)).toEqual(["⏳", ""]));
    await h.close();
    expect(fake.indicators).toHaveLength(2);
  });

  it("HTTP-shaped servers share indicators across requests, so a later reply clears it", async () => {
    const provider = new StaticCallerProvider(new FmsgClient(fake.baseUrl, "fmsgk_alice_secret"));
    const h = await connectHttpShaped(fake, provider, undefined);
    try {
      const m = fake.seed({ from: BOB, to: [ALICE], topic: "t", data: "x" });
      structured(await call(h.client, "indicate", { id: m.id }));
      await sleep(50);
      expect(fake.indicators.map((i) => i.emoji)).toEqual(["⏳"]);
      structured(await call(h.client, "reply", { id: m.id, body: "done" }));
      await vi.waitFor(() => expect(fake.indicators.map((i) => i.emoji)).toEqual(["⏳", ""]));
    } finally {
      await h.close();
      provider.close();
    }
  });
});

describe("indicator WebSocket events", () => {
  let fake: FakeFmsgServer;
  beforeEach(async () => { fake = new FakeFmsgServer(); await fake.start(); });
  afterEach(async () => fake.stop());

  it("parse without error and are ignored by wait_for_message", async () => {
    expect(parseWsEvent(Buffer.from('{"type":"indicator","data":{"id":5,"root_id":4,"from":"@bob@example.net","emoji":"⏳","ttl":60}}')))
      .toMatchObject({ type: "indicator", data: { id: "5", from: BOB } });
    expect(parseWsEvent(Buffer.from('{"type":"something_new","data":{"x":1}}'))).toEqual({ type: "something_new" });

    const alice = new FmsgClient(fake.baseUrl, "fmsgk_alice_secret");
    const bob = new FmsgClient(fake.baseUrl, "fmsgk_bob_secret");
    const root = fake.seed({ from: ALICE, to: [BOB], topic: "t", data: "question" });
    const pending = waitForMessage(alice, ALICE, { timeoutMs: 5000, settleMs: 0, afterId: root.id });
    await vi.waitFor(() => expect(fake.connectedSockets(ALICE)).toBe(1));
    await bob.indicate(root.id, "⏳", 60);
    await sleep(200);
    const answer = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "answer" });
    fake.push(answer);
    const result = await pending;
    expect(result.status).toBe("message");
    expect(result.messages.map((m) => m.id)).toEqual([answer.id]);
    alice.close();
    bob.close();
  });
});
