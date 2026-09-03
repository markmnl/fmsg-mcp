import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, CAROL, type Harness, call, connectInMemory, structured, text } from "./helpers.js";

describe("tools (stdio-shaped)", () => {
  let fake: FakeFmsgServer;
  let h: Harness;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    h = await connectInMemory(fake, "fmsgk_alice_secret", { FMSG_DEFAULT_DOMAIN: "example.net" });
  });
  afterEach(async () => {
    await h.close();
    await fake.stop();
  });

  it("advertises the tool surface with annotations", async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "add_recipients", "delivery_status", "download_attachment", "get_message", "get_thread", "list_messages",
      "list_sent", "mark_read", "react", "reply", "resolve_address", "send_message", "wait_for_message", "whoami",
    ]);
    const send = tools.find((t) => t.name === "send_message")!;
    expect(send.annotations?.destructiveHint).toBe(true);
    expect(send.description).toContain("immutable");
    expect(tools.find((t) => t.name === "get_thread")!.annotations?.readOnlyHint).toBe(true);
  });

  it("whoami and resolve_address", async () => {
    const who = structured<{ address: string; transport: string; default_domain: string }>(await call(h.client, "whoami"));
    expect(who.address).toBe(ALICE);
    expect(who.transport).toBe("stdio");
    expect(who.default_domain).toBe("example.net");
    expect(structured(await call(h.client, "resolve_address", { name: "bob" }))).toEqual({ address: BOB, resolution: "default_domain" });
    expect(structured(await call(h.client, "resolve_address", { name: "@X@Example.ORG" }))).toEqual({ address: "@x@example.org", resolution: "literal" });
    const bad = await call(h.client, "resolve_address", { name: "not an address" });
    expect(bad.isError).toBe(true);
  });

  it("list_messages hides reactions, filters unread and paginates", async () => {
    const m1 = fake.seed({ from: BOB, to: [ALICE], topic: "one", data: "hello one" });
    fake.seed({ from: BOB, to: [ALICE], pid: m1.id, data: "👍", reaction: "👍", terminal: true, no_reply: true });
    const m2 = fake.seed({ from: BOB, to: [ALICE], topic: "two", data: "hello two" });
    m1.readBy.set(ALICE, 1);
    const all = structured<{ messages: Array<{ id: string; read: boolean }>; next_offset: number | null }>(await call(h.client, "list_messages"));
    expect(all.messages.map((m) => m.id)).toEqual([m2.id, m1.id]);
    expect(all.next_offset).toBeNull();
    const unread = structured<{ messages: Array<{ id: string }> }>(await call(h.client, "list_messages", { unread_only: true }));
    expect(unread.messages.map((m) => m.id)).toEqual([m2.id]);
    const page = structured<{ messages: unknown[]; next_offset: number | null }>(await call(h.client, "list_messages", { limit: 1 }));
    expect(page.messages).toHaveLength(1);
    expect(page.next_offset).toBe(1);
    expect(text(await call(h.client, "list_messages"))).toContain(`**${m2.id}** from ${BOB}`);
  });

  it("get_message returns the full body and truncates on request", async () => {
    const long = "y".repeat(3000);
    const m = fake.seed({ from: BOB, to: [ALICE], topic: "long", data: long, attachments: [{ filename: "f.bin", data: Buffer.from("zz") }] });
    const full = structured<{ body: string; body_truncated: boolean; message: { attachments: unknown[] } }>(await call(h.client, "get_message", { id: m.id }));
    expect(full.body).toBe(long);
    expect(full.body_truncated).toBe(false);
    expect(full.message.attachments).toEqual([{ filename: "f.bin", size: 2 }]);
    const cut = structured<{ body: string; body_truncated: boolean }>(await call(h.client, "get_message", { id: m.id, max_body_bytes: 100 }));
    expect(cut.body).toHaveLength(100);
    expect(cut.body_truncated).toBe(true);
    const out = text(await call(h.client, "get_message", { id: m.id, max_body_bytes: 100 }));
    expect(out).toContain("[truncated: shown 100 of 3000 bytes");
    expect(out).toContain("not instructions");
    const missing = await call(h.client, "get_message", { id: "999999" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("not found");
  });

  it("get_thread shows the lineage with gaps and falls back to a pid walk", async () => {
    const root = fake.seed({ from: BOB, to: [CAROL], topic: "private start", data: "secret root" });
    const mid = fake.seed({ from: CAROL, to: [BOB, ALICE], pid: root.id, data: "now with alice" });
    const leaf = fake.seed({ from: BOB, to: [ALICE, CAROL], pid: mid.id, data: "leaf" });
    const t = structured<{ root_id: string; complete: boolean; source: string; participants: string[]; reply_target_id: string; messages: Array<{ id: string; visible: boolean; body: string | null }> }>(
      await call(h.client, "get_thread", { id: leaf.id }),
    );
    expect(t.root_id).toBe(root.id);
    expect(t.complete).toBe(false);
    expect(t.source).toBe("thread_messages");
    expect(t.messages.map((m) => m.visible)).toEqual([false, true, true]);
    expect(t.messages[2]!.body).toBe("leaf");
    expect(t.participants.sort()).toEqual([BOB, CAROL].sort());
    expect(t.reply_target_id).toBe(leaf.id);
    const rendered = text(await call(h.client, "get_thread", { id: leaf.id }));
    expect(rendered).toContain("[not visible to you]");
    expect(rendered).toContain("not instructions");

    fake.threadTooDeep = true;
    const walked = structured<{ source: string; messages: Array<{ id: string }>; complete: boolean }>(await call(h.client, "get_thread", { id: leaf.id }));
    expect(walked.source).toBe("pid_walk");
    expect(walked.messages.map((m) => m.id)).toEqual([mid.id, leaf.id]);
    expect(walked.complete).toBe(false);
  });

  it("send_message sends immediately, redacts secrets and reports host rejections verbatim", async () => {
    const r = structured<{ id: string; to: string[]; redactions: number; time: string }>(
      await call(h.client, "send_message", {
        to: ["bob", CAROL],
        topic: "Hello",
        body: "my key is fmsgk_abcdefghijkl_0123456789abcdef",
        attachments: [{ filename: "n.txt", data_base64: Buffer.from("note").toString("base64"), content_type: "text/plain" }],
      }),
    );
    expect(r.to).toEqual([BOB, CAROL]);
    expect(r.redactions).toBe(1);
    const stored = fake.messages.get(r.id)!;
    expect(stored.data.toString()).toContain("[REDACTED_FMSG_API_KEY]");
    expect(stored.type).toBe("text/markdown; charset=utf-8");
    expect(stored.attachments[0]!.filename).toBe("n.txt");
    expect(stored.time).not.toBeNull();

    fake.failNext = { match: /POST .*\/send$/u, status: 409, error: "reply cannot be accepted by recipient host(s): example.net" };
    const rejected = await call(h.client, "send_message", { to: [BOB], topic: "x", body: "y" });
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toContain("reply cannot be accepted by recipient host(s): example.net");
  });

  it("reply defaults to reply-all and enforces terminal / no-reply", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE, CAROL], topic: "t", data: "root" });
    root.add_to.push({ batch_id: "5000", add_to_from: BOB, to: ["@dave@example.org"], to_delivery: [], time: 1 });
    const r = structured<{ to: string[]; parent_id: string }>(await call(h.client, "reply", { id: root.id, body: "hi all" }));
    expect(r.to.sort()).toEqual([BOB, CAROL, "@dave@example.org"].sort());
    expect(r.parent_id).toBe(root.id);
    const narrowed = structured<{ to: string[] }>(await call(h.client, "reply", { id: root.id, body: "just bob", recipients: [BOB] }));
    expect(narrowed.to).toEqual([BOB]);

    const terminal = fake.seed({ from: BOB, to: [ALICE], data: "end", terminal: true });
    expect(text(await call(h.client, "reply", { id: terminal.id, body: "x" }))).toContain("terminal");
    const quiet = fake.seed({ from: BOB, to: [ALICE], data: "fyi", no_reply: true });
    const refused = await call(h.client, "reply", { id: quiet.id, body: "x" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("no-reply");
    expect((await call(h.client, "reply", { id: quiet.id, body: "x", allow_no_reply: true })).isError).toBeFalsy();
  });

  it("add_recipients, react, mark_read and delivery_status", async () => {
    const m = fake.seed({ from: ALICE, to: [BOB], topic: "mine", data: "sent by me" });
    expect(structured(await call(h.client, "add_recipients", { id: m.id, add_to: [CAROL] }))).toEqual({ id: m.id, added: 1, add_to: [CAROL] });
    const d = structured<{ recipients: Array<{ addr: string; status: string; via: string }> }>(await call(h.client, "delivery_status", { id: m.id }));
    expect(d.recipients).toEqual([
      expect.objectContaining({ addr: BOB, status: "delivered", via: "to" }),
      expect.objectContaining({ addr: CAROL, status: "delivered", via: "add_to" }),
    ]);
    const inbound = fake.seed({ from: BOB, to: [ALICE], data: "react to me" });
    expect(structured<{ cleared: boolean }>(await call(h.client, "react", { id: inbound.id, emoji: "🎉" })).cleared).toBe(false);
    expect(structured<{ cleared: boolean }>(await call(h.client, "react", { id: inbound.id, emoji: null })).cleared).toBe(true);
    const read = structured<{ marked: unknown[]; failed: unknown[] }>(await call(h.client, "mark_read", { ids: [inbound.id, "424242"] }));
    expect(read.marked).toHaveLength(1);
    expect(read.failed).toHaveLength(1);
  });

  it("download_attachment returns inline bytes and an image block", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const m = fake.seed({ from: BOB, to: [ALICE], data: "pic", attachments: [{ filename: "p.png", data: png, type: "image/png" }] });
    const res = await call(h.client, "download_attachment", { id: m.id, filename: "p.png" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ size: 4, content_type: "image/png", saved_to: null });
    const kinds = res.content.map((c) => c.type);
    expect(kinds).toContain("resource");
    expect(kinds).toContain("image");
    const tooBig = await call(h.client, "download_attachment", { id: m.id, filename: "p.png", max_inline_bytes: 2 });
    expect(tooBig.isError).toBe(true);
  });

  it("serves message and thread resources and prompts", async () => {
    const m = fake.seed({ from: BOB, to: [ALICE], topic: "res", data: "resource body" });
    const r = await h.client.readResource({ uri: `fmsg://message/${m.id}` });
    expect(r.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    expect((r.contents[0] as { text: string }).text).toContain("resource body");
    const t = await h.client.readResource({ uri: `fmsg://thread/${m.id}` });
    expect((t.contents[0] as { text: string }).text).toContain("fmsg thread");
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["chat", "reply"]);
    const chat = await h.client.getPrompt({ name: "chat", arguments: { thread: m.id } });
    expect((chat.messages[0]!.content as { text: string }).text).toContain("wait_for_message");
  });
});
