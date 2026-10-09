import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeFmsgAddress, resolveAddress } from "../src/address.js";
import { LINEAGE_ONLY } from "../src/thread.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, CAROL, type Harness, call, connectInMemory, structured, text } from "./helpers.js";

/** Results must not mislead a model that reads only the text or only the structured content. */
describe("result clarity", () => {
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

  it("wait_for_message names messages from other threads that after_id moved past", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "thread A", data: "a1" });
    const other = fake.seed({ from: CAROL, to: [ALICE], topic: "thread B", data: "b1" });
    const follow = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "a2" });
    const result = await call(h.client, "wait_for_message", { after_id: String(Number(root.id) - 1), timeout_seconds: 5, settle_seconds: 1 });
    const r = structured<{
      messages: Array<{ id: string }>; after_id: string; pending_ids: string[]; pending_other_threads: unknown[]; next: string;
    }>(result);
    expect(r.messages.map((m) => m.id)).toEqual([root.id, follow.id]);
    // The cursor passes the other thread's message, so the result must say so.
    expect(r.after_id).toBe(follow.id);
    expect(r.pending_other_threads).toEqual([{ id: other.id, from: CAROL, root_id: other.id }]);
    expect(r.pending_ids).toEqual([other.id]);
    expect(r.next).toContain(`Reply to message ${follow.id} with the reply tool.`);
    expect(r.next).toContain(`Also new and not included here: message ${other.id} in another thread (root ${other.id})`);
    expect(r.next).toContain(`get_thread (or get_message) "${other.id}"`);
    expect(r.next.indexOf(`message ${other.id}`)).toBeLessThan(r.next.indexOf(`after_id "${follow.id}"`));
    expect(r.next).toMatch(/Then call wait_for_message with after_id "\d+" to keep listening\.$/u);
    expect(text(result)).toContain(r.next);
    const tool = (await h.client.listTools()).tools.find((t) => t.name === "wait_for_message")!;
    expect(tool.description).toContain("a later wait will not return them");
  });

  it("get_thread says it returns the lineage only and keeps complete about the lineage", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "branches", data: "root" });
    fake.seed({ from: ALICE, to: [BOB], pid: root.id, data: "a sibling reply" });
    const leaf = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "another reply" });
    const result = await call(h.client, "get_thread", { id: leaf.id });
    const t = structured<{ scope: string; complete: boolean; messages: Array<{ id: string }>; next: string }>(result);
    expect(t.scope).toBe("lineage");
    expect(t.complete).toBe(true);
    expect(t.messages.map((m) => m.id)).toEqual([root.id, leaf.id]);
    expect(t.next).toContain(LINEAGE_ONLY);
    expect(text(result)).toContain(LINEAGE_ONLY);
    const tool = (await h.client.listTools()).tools.find((t) => t.name === "get_thread")!;
    expect(tool.description).toContain("other replies in the same thread");
    expect(JSON.stringify(tool.outputSchema)).toContain("says nothing about other replies");
  });

  it("renders addresses as code spans so copies keep underscores unescaped", async () => {
    const odd = "@bob_mcp@example.org";
    const m = fake.seed({ from: odd, to: [ALICE, "@carol_x@example.org"], topic: "under_score", data: "hi" });
    const message = text(await call(h.client, "get_message", { id: m.id }));
    expect(message).toContain("From: `@bob_mcp@example.org`");
    expect(message).toContain("To: `@alice@example.com`, `@carol_x@example.org`");
    expect(message).not.toContain("bob\\_mcp");
    expect(message).toContain("Topic: under\\_score");
    expect(text(await call(h.client, "list_messages"))).toContain("from `@bob_mcp@example.org`");
    expect(text(await call(h.client, "get_thread", { id: m.id }))).toContain(`--- message ${m.id} from \`@bob_mcp@example.org\``);
    expect(text(await call(h.client, "resolve_address", { name: odd }))).toContain("→ `@bob_mcp@example.org`");
    // A value a code span cannot hold falls back to escaped text.
    const tick = fake.seed({ from: "@x`y@example.org", to: [ALICE], data: "tick" });
    expect(text(await call(h.client, "get_message", { id: tick.id }))).toContain("From: @x\\`y@example.org");
  });

  it("rejects Markdown-escaped and malformed addresses", async () => {
    const escaped = await call(h.client, "resolve_address", { name: "@bob\\_mcp@example.org" });
    expect(escaped.isError).toBe(true);
    expect(text(escaped)).toContain("backslash");
    const short = await call(h.client, "resolve_address", { name: "bob\\_mcp" });
    expect(short.isError).toBe(true);
    expect(text(short)).toContain("backslash");
    const send = await call(h.client, "send_message", { to: ["@bob\\_mcp@example.org"], topic: "t", body: "b" });
    expect(send.isError).toBe(true);
    expect(fake.requests.some((r) => r.method === "POST" && r.path === "/fmsg")).toBe(false);

    expect(normalizeFmsgAddress("@Bob_Mcp@Example.ORG")).toBe("@Bob_Mcp@example.org");
    expect(normalizeFmsgAddress("@élodie.k@exemple.fr")).toBe("@élodie.k@exemple.fr");
    expect(normalizeFmsgAddress("@a-b.c_d@host.example.com:4930")).toBe("@a-b.c_d@host.example.com:4930");
    for (const bad of [
      "@bob\\_mcp@example.org", "@bob@exam\\ple.org", "@bob\u0000@example.org", "@bob​@example.org", "@.bob@example.org",
      "@bob.@example.org", "@bo..b@example.org", "@bo_-b@example.org", "@bo+b@example.org", "@bob@-example.org",
      `@${"a".repeat(250)}@example.org`,
    ]) expect(normalizeFmsgAddress(bad), JSON.stringify(bad)).toBeUndefined();
    expect(() => resolveAddress("@bo..b@example.org")).toThrow("user part");
  });

  it("carries thread flags and added recipients and never suggests replying to no-reply or terminal messages", async () => {
    const root = fake.seed({ from: ALICE, to: [BOB], topic: "flags", data: "root", important: true });
    expect(structured(await call(h.client, "add_recipients", { id: root.id, recipients: [CAROL] }))).toMatchObject({ added: 1 });
    const quiet = fake.seed({ from: BOB, to: [ALICE, CAROL], pid: root.id, data: "no replies please", no_reply: true });
    const result = await call(h.client, "get_thread", { id: quiet.id });
    type Thread = {
      no_reply: boolean; terminal: boolean; next: string;
      messages: Array<{ id: string; no_reply: boolean; terminal: boolean; important: boolean; added: string[] }>;
    };
    const t = structured<Thread>(result);
    expect(t.messages[0]).toMatchObject({ id: root.id, important: true, no_reply: false, terminal: false, added: [CAROL] });
    expect(t.messages[1]).toMatchObject({ id: quiet.id, no_reply: true, terminal: false, added: [] });
    expect(t.no_reply).toBe(true);
    expect(t.next).toContain(`Message ${quiet.id} is marked no-reply`);
    expect(t.next).toContain("allow_no_reply");
    expect(t.next).not.toContain("To continue this thread");
    expect(text(result)).toContain(`--- message ${quiet.id} from \`${BOB}\``);
    expect(text(result)).toMatch(new RegExp(`--- message ${quiet.id} .* · no-reply ---`, "u"));
    expect(text(result)).toContain(`added: \`${CAROL}\``);
    expect(text(result)).toContain(t.next);

    const end = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "the end", terminal: true });
    const terminal = structured<Thread>(await call(h.client, "get_thread", { id: end.id }));
    expect(terminal.next).toContain(`Message ${end.id} is terminal: no replies are possible`);
    expect(terminal.messages[1]).toMatchObject({ terminal: true });
    // The pid-walk fallback carries the same fields.
    fake.threadTooDeep = true;
    const walked = structured<Thread & { source: string }>(await call(h.client, "get_thread", { id: quiet.id }));
    expect(walked.source).toBe("pid_walk");
    expect(walked.messages[1]).toMatchObject({ no_reply: true, terminal: false });
    expect(walked.messages[0]).toMatchObject({ added: [CAROL] });
  });

  it("labels size as the wire size and reports compression", async () => {
    const body = "compressible ".repeat(40);
    const m = fake.seed({ from: BOB, to: [ALICE], topic: "zip", data: body, deflate: true, wireSize: 40 });
    const listed = structured<{ messages: Array<{ id: string; size: number; compressed: boolean }> }>(await call(h.client, "list_messages"));
    expect(listed.messages[0]).toMatchObject({ id: m.id, size: 40, compressed: true });
    const got = await call(h.client, "get_message", { id: m.id });
    expect(structured<{ message: { compressed: boolean }; body_bytes: number }>(got)).toMatchObject({ message: { compressed: true }, body_bytes: body.length });
    expect(text(got)).toContain("40 bytes compressed");
    const thread = structured<{ messages: Array<{ size: number; compressed: boolean; body_bytes: number }> }>(await call(h.client, "get_thread", { id: m.id }));
    expect(thread.messages[0]).toMatchObject({ size: 40, compressed: true, body_bytes: body.length });
    const plain = fake.seed({ from: BOB, to: [ALICE], data: "plain" });
    expect(structured<{ message: { compressed: boolean } }>(await call(h.client, "get_message", { id: plain.id })).message.compressed).toBe(false);
    const { tools } = await h.client.listTools();
    expect(JSON.stringify(tools.find((t) => t.name === "list_messages")!.outputSchema)).toContain("bytes on the wire; the compressed length when compressed is true");
  });

  it("download_attachment names the media type type and lists the attachments a message has", async () => {
    const m = fake.seed({ from: BOB, to: [ALICE], topic: "files", data: "x", attachments: [
      { filename: "b.txt", data: Buffer.from("b"), type: "text/plain" },
      { filename: "a.txt", data: Buffer.from("a"), type: "text/plain" },
    ] });
    const ok = structured<{ type: string; content_type: string }>(await call(h.client, "download_attachment", { id: m.id, filename: "a.txt" }));
    expect(ok.type).toBe(ok.content_type);
    expect(ok.type).toContain("text/plain");
    const wrong = await call(h.client, "download_attachment", { id: m.id, filename: "c.txt" });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain(`Message ${m.id} has no attachment named "c.txt"`);
    expect(text(wrong)).toContain(`"a.txt", "b.txt"`);
    expect(text(wrong)).not.toContain("may not be visible");
    const none = fake.seed({ from: BOB, to: [ALICE], data: "no files" });
    expect(text(await call(h.client, "download_attachment", { id: none.id, filename: "a.txt" }))).toContain("It has no attachments.");
    // A message that cannot be read keeps the visibility hint.
    const hidden = fake.seed({ from: BOB, to: [CAROL], data: "not yours", attachments: [{ filename: "a.txt", data: Buffer.from("a") }] });
    const denied = await call(h.client, "download_attachment", { id: hidden.id, filename: "a.txt" });
    expect(denied.isError).toBe(true);
    expect(text(denied)).not.toContain("has no attachment named");
  });

  it("describes delivery_status for received messages and what via means", async () => {
    const tool = (await h.client.listTools()).tools.find((t) => t.name === "delivery_status")!;
    expect(tool.description).toContain("for a received message");
    expect(tool.description).toContain("add_to for recipients added later with the fmsg add-to mechanism");
    const received = fake.seed({ from: BOB, to: [ALICE], data: "hi" });
    const status = await call(h.client, "delivery_status", { id: received.id });
    expect(structured<{ recipients: Array<{ addr: string }> }>(status).recipients.map((r) => r.addr)).toEqual([ALICE]);
    expect(text(status)).toContain(`- \`${ALICE}\`: delivered`);
  });

  it("reports thread_topic on get_message and on send and reply results", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "the plan", data: "root" });
    const mid = fake.seed({ from: BOB, to: [ALICE], pid: root.id, data: "middle" });
    const leaf = fake.seed({ from: BOB, to: [ALICE], pid: mid.id, data: "leaf" });
    const before = fake.requests.length;
    const own = await call(h.client, "get_message", { id: root.id });
    expect(structured<{ thread_topic: string }>(own).thread_topic).toBe("the plan");
    // The root needs no extra lookup.
    expect(fake.requests.slice(before).some((r) => r.path.includes("/thread"))).toBe(false);
    const deep = await call(h.client, "get_message", { id: leaf.id });
    expect(structured<{ thread_topic: string }>(deep).thread_topic).toBe("the plan");
    expect(text(deep)).toContain("Thread topic: the plan");

    const sent = structured<{ thread_topic: string }>(await call(h.client, "send_message", { to: ["bob"], topic: "kickoff", body: "hi" }));
    expect(sent.thread_topic).toBe("kickoff");
    const toRoot = await call(h.client, "reply", { id: root.id, body: "ok" });
    expect(structured<{ thread_topic: string }>(toRoot).thread_topic).toBe("the plan");
    expect(text(toRoot)).toContain(`in "the plan"`);
    expect(text(toRoot)).toContain(`for \`${BOB}\``);
    expect(structured<{ thread_topic: string | null }>(await call(h.client, "reply", { id: leaf.id, body: "ok" })).thread_topic).toBeNull();
  });
});
