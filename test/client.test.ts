import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FmsgClient, FmsgHttpError } from "../src/client/client.js";
import { parseFmsgJson, stringifyWithIds, normalizeMessageId } from "../src/client/message-id.js";
import { redactSecrets } from "../src/client/redact.js";
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

describe("redaction", () => {
  it("replaces keys and JWTs and counts them", () => {
    const r = redactSecrets("key fmsgk_abcdefghijkl_0123456789 and token eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl end");
    expect(r.text).not.toContain("fmsgk_abc");
    expect(r.text).not.toContain("eyJ");
    expect(r.count).toBe(2);
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
  afterEach(async () => fake.stop());

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
