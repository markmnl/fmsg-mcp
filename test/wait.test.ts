import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FmsgClient, FmsgHttpError } from "../src/client/client.js";
import { waitForMessage } from "../src/wait.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, CAROL, call, connectInMemory, sleep, structured } from "./helpers.js";

describe("waitForMessage", () => {
  let fake: FakeFmsgServer;
  let client: FmsgClient;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    client = new FmsgClient(fake.baseUrl, "fmsgk_alice_secret");
    await client.address();
  });
  afterEach(async () => fake.stop());

  const opts = (o: Partial<Parameters<typeof waitForMessage>[2]> = {}) => ({ timeoutMs: 5000, settleMs: 300, ...o });

  it("returns a message pushed over the WebSocket and skips own / no_reply / reactions", async () => {
    const p = waitForMessage(client, ALICE, opts());
    await sleep(300);
    expect(fake.connectedSockets(ALICE)).toBe(1);
    fake.push(fake.seed({ from: ALICE, to: [BOB], data: "mine" }));
    fake.push(fake.seed({ from: BOB, to: [ALICE], data: "quiet", no_reply: true }));
    const parent = fake.seed({ from: BOB, to: [ALICE], data: "p" });
    fake.push(fake.seed({ from: BOB, to: [ALICE], pid: parent.id, data: "👍", reaction: "👍", terminal: true, no_reply: true }));
    const real = fake.seed({ from: BOB, to: [ALICE], topic: "hey", data: "real one" });
    fake.push(real);
    const r = await p;
    expect(r.status).toBe("message");
    expect(r.transport).toBe("websocket");
    expect(r.messages.map((m) => m.id)).toEqual([real.id]);
    expect(r.after_id).toBe(real.id);
    expect(r.thread_root_id).toBe(real.id);
    await sleep(200);
    expect(fake.connectedSockets(ALICE)).toBe(0);
  });

  it("catches up on messages that landed before the socket opened", async () => {
    const before = fake.seed({ from: BOB, to: [ALICE], data: "already there" });
    const r = await waitForMessage(client, ALICE, opts({ afterId: "1" }));
    expect(r.messages.map((m) => m.id)).toEqual([before.id]);
  });

  it("delivers in the same wait when an announced message becomes readable 300ms later", async () => {
    const pending = waitForMessage(client, ALICE, opts({ afterId: "0", timeoutMs: 2500, settleMs: 0 }));
    await vi.waitFor(() => expect(fake.connectedSockets(ALICE)).toBe(1));
    const early = fake.seed({ from: BOB, to: [ALICE], data: "available shortly" });
    fake.messages.delete(early.id);
    fake.push(early);
    const restore = setTimeout(() => fake.messages.set(early.id, early), 300);
    try {
      const result = await pending;
      expect(result.status).toBe("message");
      expect(result.messages.map(m => m.id)).toEqual([early.id]);
      expect(result.unclassified).toEqual([]);
    } finally { clearTimeout(restore); }
  });

  it("batches same-thread messages within the settle window and reports other threads as pending", async () => {
    const p = waitForMessage(client, ALICE, opts({ settleMs: 800 }));
    await sleep(300);
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "thread A", data: "a1" });
    fake.push(root);
    await sleep(100);
    const other = fake.seed({ from: CAROL, to: [ALICE], topic: "thread B", data: "b1" });
    fake.push(other);
    const follow = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "a2" });
    fake.push(follow);
    const r = await p;
    expect(r.messages.map((m) => m.id)).toEqual([root.id, follow.id]);
    expect(r.pending_other_threads).toEqual([{ id: other.id, from: CAROL, root_id: other.id }]);
    expect(r.after_id).toBe(follow.id);
  });

  it("catches up after exhausted early-announcement retries without a second push", async () => {
    const pending = waitForMessage(client, ALICE, opts({ afterId: "0", timeoutMs: 4000, settleMs: 0 }));
    await vi.waitFor(() => expect(fake.connectedSockets(ALICE)).toBe(1));
    const message = fake.seed({ from: BOB, to: [ALICE], data: "visible after the retry window" });
    fake.messages.delete(message.id);
    const read = vi.spyOn(client, "getMessage");
    try {
      fake.push(message);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3), { timeout: 2500 });
      await expect(read.mock.results[2]!.value).rejects.toMatchObject({ status: 404 });
      fake.messages.set(message.id, message);
      const result = await pending;
      expect(result.status).toBe("message");
      expect(result.messages.map(m => m.id)).toEqual([message.id]);
      expect(result.unclassified).toEqual([]);
      expect(result.after_id).toBe(message.id);
    } finally { read.mockRestore(); }
  });

  it("recovers a failed protected read on a later announcement in the same wait", async () => {
    const pending = waitForMessage(client, ALICE, opts({ afterId: "0", settleMs: 0 }));
    await vi.waitFor(() => expect(fake.connectedSockets(ALICE)).toBe(1));
    const message = fake.seed({ from: BOB, to: [ALICE], data: "retry later" });
    const read = vi.spyOn(client, "getMessage").mockRejectedValue(new FmsgHttpError("not readable yet", 404, "GET", `/fmsg/${message.id}`));
    try {
      fake.push(message);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3), { timeout: 2500 });
      read.mockRestore();
      fake.push(message);
      const result = await pending;
      expect(result.status).toBe("message");
      expect(result.messages.map(m => m.id)).toEqual([message.id]);
      expect(result.unclassified).toEqual([]);
      expect(result.after_id).toBe(message.id);
    } finally { read.mockRestore(); }
  });

  it("honours thread_of and from filters", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "A", data: "a" });
    const p = waitForMessage(client, ALICE, opts({ threadOf: root.id }));
    await sleep(300);
    fake.push(fake.seed({ from: BOB, to: [ALICE], topic: "B", data: "unrelated" }));
    const inThread = fake.seed({ from: CAROL, to: [ALICE], pid: root.id, data: "in A" });
    fake.push(inThread);
    const r = await p;
    expect(r.messages.map((m) => m.id)).toEqual([inThread.id]);
    expect(r.thread_root_id).toBe(root.id);

    const p2 = waitForMessage(client, ALICE, opts({ from: BOB }));
    await sleep(300);
    fake.push(fake.seed({ from: CAROL, to: [ALICE], data: "not bob" }));
    const fromBob = fake.seed({ from: BOB, to: [ALICE], data: "bob" });
    fake.push(fromBob);
    expect((await p2).messages.map((m) => m.id)).toEqual([fromBob.id]);
  });

  it("times out and advances after_id past skipped messages, and honours abort", async () => {
    const p = waitForMessage(client, ALICE, opts({ timeoutMs: 700 }));
    await sleep(200);
    const skipped = fake.seed({ from: BOB, to: [ALICE], data: "skip", no_reply: true });
    fake.push(skipped);
    const r = await p;
    expect(r.status).toBe("timeout");
    expect(r.after_id).toBe(skipped.id);

    const ac = new AbortController();
    const p2 = waitForMessage(client, ALICE, opts({ timeoutMs: 10_000 }), ac.signal);
    await sleep(100);
    ac.abort();
    const r2 = await p2;
    expect(r2.status).toBe("timeout");
    expect(r2.note).toBe("cancelled");
  });

  it("lists other-thread skips and still returns the in-thread match with the cursor advanced", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "A", data: "a" });
    const p = waitForMessage(client, ALICE, opts({ threadOf: root.id }));
    await sleep(300);
    const other = fake.seed({ from: CAROL, to: [ALICE], topic: "B", data: "elsewhere" });
    fake.push(other);
    await sleep(100);
    const inThread = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "here" });
    fake.push(inThread);
    const r = await p;
    expect(r.status).toBe("message");
    expect(r.messages.map((m) => m.id)).toEqual([inThread.id]);
    expect(r.skipped).toEqual([{ id: other.id, reason: "other_thread" }]);
    expect(r.unclassified).toEqual([]);
    expect(r.after_id).toBe(inThread.id);
  });

  it("never advances the cursor past a message whose thread it could not determine", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "A", data: "a" });
    const p = waitForMessage(client, ALICE, opts({ threadOf: root.id, timeoutMs: 3000 }));
    await sleep(300);
    // The host announces the message before it is readable: pushed, not stored.
    const ghost = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "announced early" });
    fake.messages.delete(ghost.id);
    fake.push(ghost);
    await sleep(100);
    const later = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "after the gap" });
    fake.push(later);
    const r = await p;
    expect(r.unclassified.map((u) => u.id)).toEqual([ghost.id]);
    expect(BigInt(r.after_id) < BigInt(ghost.id)).toBe(true);
    expect(r.note).toContain("cursor held");

    // Once readable, a wait from the held cursor delivers both in order.
    fake.messages.set(ghost.id, ghost);
    const r2 = await waitForMessage(client, ALICE, opts({ threadOf: root.id, afterId: r.after_id, settleMs: 500 }));
    expect(r2.status).toBe("message");
    expect(r2.messages.map((m) => m.id)).toEqual([ghost.id, later.id]);
    expect(r2.after_id).toBe(later.id);
    expect(r2.unclassified).toEqual([]);
  });

  it("falls back to polling when the socket cannot open", async () => {
    const p = waitForMessage(client, ALICE, opts({ pollIntervalMs: 100 }), undefined, {
      openSocket: async () => {
        throw new Error("no ws");
      },
    });
    await sleep(150);
    fake.push(fake.seed({ from: BOB, to: [ALICE], data: "polled" }));
    const r = await p;
    expect(r.status).toBe("message");
    expect(r.transport).toBe("poll");
  });

  it("wait_for_message tool returns thread context and a reply target", async () => {
    const h = await connectInMemory(fake);
    try {
      const p = call(h.client, "wait_for_message", { timeout_seconds: 5, settle_seconds: 0 });
      await sleep(400);
      const m = fake.seed({ from: BOB, to: [ALICE], topic: "tool", data: "via tool" });
      fake.push(m);
      const r = structured<{ status: string; reply_target_id: string; messages: Array<{ body: string }> }>(await p);
      expect(r.status).toBe("message");
      expect(r.reply_target_id).toBe(m.id);
      expect(r.messages[0]!.body).toBe("via tool");
    } finally {
      await h.close();
    }
  });
});
