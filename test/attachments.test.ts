import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeBase64Strict } from "../src/tools/attachments.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, CAROL, type Harness, call, connectInMemory, structured, text } from "./helpers.js";

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

describe("strict base64", () => {
  it("decodes valid input, with or without padding and line breaks", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253]);
    const encoded = bytes.toString("base64");
    expect(decodeBase64Strict("a", encoded)).toEqual(bytes);
    expect(decodeBase64Strict("a", encoded.replace(/=+$/u, ""))).toEqual(bytes);
    expect(decodeBase64Strict("a", `${encoded.slice(0, 4)}\n${encoded.slice(4)}\r\n`)).toEqual(bytes);
  });

  it("names the attachment and the problem for corrupt input", () => {
    expect(() => decodeBase64Strict("r.pdf", "QUJD*REVG")).toThrow('attachment r.pdf: invalid base64 character "*" at position 4');
    expect(() => decodeBase64Strict("r.pdf", "QUJDREVGR")).toThrow("attachment r.pdf: invalid base64 length or padding");
    expect(() => decodeBase64Strict("r.pdf", "QU=JD")).toThrow("invalid base64 length or padding");
    expect(() => decodeBase64Strict("r.pdf", "QUI===")).toThrow("invalid base64 length or padding");
    expect(decodeBase64Strict("r.pdf", "QUI=")).toEqual(Buffer.from("AB"));
    expect(() => decodeBase64Strict("r.pdf", "QUJ=")).toThrow("attachment r.pdf: invalid base64 ending");
    expect(() => decodeBase64Strict("r.pdf", "QUJD-_")).toThrow("invalid base64 character");
  });
});

describe("attachment sources", () => {
  let fake: FakeFmsgServer;
  let h: Harness;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    h = await connectInMemory(fake);
  });
  afterEach(async () => {
    await h.close();
    await fake.stop();
  });

  const drafts = () => [...fake.messages.values()].filter((m) => m.from === ALICE);

  it("refuses corrupt base64 and a sha256 mismatch before creating a draft", async () => {
    const corrupt = await call(h.client, "send_message", { to: [BOB], topic: "t", body: "b", attachments: [{ filename: "r.bin", data_base64: "QUJD*REVG" }] });
    expect(corrupt.isError).toBe(true);
    expect(text(corrupt)).toContain("attachment r.bin: invalid base64 character");
    const mismatch = await call(h.client, "send_message", { to: [BOB], topic: "t", body: "b",
      attachments: [{ filename: "a.txt", data_text: "hello", sha256: sha256("hellO") }] });
    expect(mismatch.isError).toBe(true);
    expect(text(mismatch)).toContain(`attachment a.txt: sha256 mismatch (expected ${sha256("hellO")}, got ${sha256("hello")}); nothing was sent`);
    expect(drafts()).toEqual([]);
  });

  it("sends data_text as exact UTF-8 and checks a matching sha256", async () => {
    const content = "naïve – 日本語 ✓\n";
    const sent = structured<{ id: string; attachments: Array<{ filename: string; size: number; type: string }> }>(await call(h.client, "send_message", {
      to: [BOB], topic: "t", body: "b",
      attachments: [{ filename: "notes.md", data_text: content, sha256: sha256(content).toUpperCase() }, { filename: "raw", data_text: "x" }],
    }));
    const stored = fake.messages.get(sent.id)!;
    expect(stored.attachments[0]!.data).toEqual(Buffer.from(content, "utf8"));
    expect(sent.attachments).toEqual([
      { filename: "notes.md", size: Buffer.byteLength(content), type: "text/markdown" },
      { filename: "raw", size: 1, type: "text/plain; charset=utf-8" },
    ]);
  });

  it("requires exactly one source per attachment", async () => {
    for (const attachment of [{ filename: "a.txt" }, { filename: "a.txt", data_text: "x", data_base64: "eA==" }]) {
      const result = await call(h.client, "send_message", { to: [BOB], topic: "t", body: "b", attachments: [attachment] });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("attachment a.txt: give exactly one of data_base64, data_text");
    }
    const unregistered = await call(h.client, "send_message", { to: [BOB], topic: "t", body: "b", attachments: [{ filename: "a.txt", path: "a.txt" }] });
    expect(unregistered.isError).toBe(true);
    expect(drafts()).toEqual([]);
  });

  it("creates, sends and deletes drafts", async () => {
    const created = structured<{ draft_id: string; topic: string; to: string[]; attachments: unknown[]; upload?: unknown; next: string; redactions: number }>(
      await call(h.client, "create_draft", { to: [BOB], topic: "plan", body: "key fmsgk_abcdefghijkl_0123456789abcdef",
        attachments: [{ filename: "a.txt", data_text: "draft file" }] }));
    expect(created).toMatchObject({ topic: "plan", to: [BOB], attachments: [{ filename: "a.txt", size: 10 }], redactions: 1 });
    expect(created.upload).toBeUndefined();
    expect(created.next).toBe("Call send_draft to send it. Call delete_draft to discard it.");
    expect(fake.messages.get(created.draft_id)!.time).toBeNull();

    const sent = structured<{ id: string; topic: string; thread_topic: string; attachments: Array<{ filename: string }> }>(
      await call(h.client, "send_draft", { id: created.draft_id }));
    expect(sent).toMatchObject({ id: created.draft_id, topic: "plan", thread_topic: "plan", attachments: [{ filename: "a.txt" }] });
    expect(fake.messages.get(created.draft_id)!.time).not.toBeNull();
    const again = await call(h.client, "send_draft", { id: created.draft_id });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain("was already sent; send_draft sends only drafts");
    const remove = await call(h.client, "delete_draft", { id: created.draft_id });
    expect(text(remove)).toContain("was already sent and cannot be deleted");

    const other = structured<{ draft_id: string }>(await call(h.client, "create_draft", { to: [BOB], topic: "x", body: "y" }));
    expect(structured(await call(h.client, "delete_draft", { id: other.draft_id }))).toEqual({ id: other.draft_id, deleted: true });
    expect(fake.messages.get(other.draft_id)!.deleted).toBe(true);
  });

  it("drafts replies with reply rules and reply-all", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE, CAROL], topic: "root", data: "hi" });
    const reply = structured<{ draft_id: string; to: string[]; parent_id: string }>(await call(h.client, "create_draft", { reply_to: root.id, body: "ok" }));
    expect(reply.to.sort()).toEqual([BOB, CAROL].sort());
    expect(reply.parent_id).toBe(root.id);
    const sent = structured<{ parent_id: string; thread_topic: string; topic: string }>(await call(h.client, "send_draft", { id: reply.draft_id }));
    expect(sent).toMatchObject({ parent_id: root.id, thread_topic: "root", topic: "" });

    const withTopic = await call(h.client, "create_draft", { reply_to: root.id, topic: "no", body: "x" });
    expect(text(withTopic)).toContain("a reply has no topic");
    expect((await call(h.client, "create_draft", { body: "x" })).isError).toBe(true);
    const quiet = fake.seed({ from: BOB, to: [ALICE], topic: "fyi", data: "x", no_reply: true });
    expect(text(await call(h.client, "create_draft", { reply_to: quiet.id, body: "x" }))).toContain("marked no-reply");
  });

  it("gives no base64 hint or large-file route when the server offers none", async () => {
    const big = Buffer.alloc(49_152, 1).toString("base64");
    const sent = await call(h.client, "send_message", { to: [BOB], topic: "t", body: "b", attachments: [{ filename: "big.bin", data_base64: big }] });
    expect(structured(sent).hint).toBeUndefined();
    const prompt = await h.client.getPrompt({ name: "send_file", arguments: { files: "a.pdf", reply_to: "7" } });
    const steps = (prompt.messages[0]!.content as { text: string }).text;
    expect(steps).toContain('1. Call reply with id "7"');
    expect(steps).toContain("This server has no upload route");
  });

  it("deletes the draft when an inline upload is refused", async () => {
    fake.failNext = { match: /\/attach$/u, status: 413, error: "attachment too large" };
    const result = await call(h.client, "create_draft", { to: [BOB], topic: "big", body: "b", attachments: [{ filename: "a.bin", data_base64: "AAAA" }] });
    expect(text(result)).toContain("attachment too large");
    expect(drafts().every((m) => m.deleted)).toBe(true);
  });
});

describe("upload folder (stdio)", () => {
  let fake: FakeFmsgServer;
  let h: Harness;
  let root: string;
  let folder: string;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    root = await mkdtemp(path.join(os.tmpdir(), "fmsg-upload-"));
    folder = path.join(root, "outbox");
    await mkdir(path.join(folder, "sub"), { recursive: true });
    h = await connectInMemory(fake, "fmsgk_alice_secret", { FMSG_MCP_UPLOAD_DIR: folder });
  });
  afterEach(async () => {
    await h.close();
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("streams files from the folder and checks their sha256", async () => {
    const bytes = Buffer.alloc(300_000, 7);
    bytes[123] = 0;
    await writeFile(path.join(folder, "sub", "big.bin"), bytes);
    const sent = structured<{ id: string; attachments: Array<{ filename: string; size: number }> }>(await call(h.client, "send_message", {
      to: [BOB], topic: "file", body: "see file", attachments: [{ filename: "big.bin", path: "sub/big.bin", sha256: sha256(bytes) }],
    }));
    expect(sent.attachments).toEqual([{ filename: "big.bin", size: bytes.byteLength, type: "application/octet-stream" }]);
    expect(fake.messages.get(sent.id)!.attachments[0]!.data).toEqual(bytes);

    const before = fake.messages.size;
    const wrong = await call(h.client, "send_message", { to: [BOB], topic: "file", body: "x",
      attachments: [{ filename: "big.bin", path: "sub/big.bin", sha256: "0".repeat(64) }] });
    expect(text(wrong)).toContain("sha256 mismatch");
    expect([...fake.messages.values()].slice(before).every((m) => m.deleted)).toBe(true);
  });

  it("refuses paths outside the folder, missing files and directories", async () => {
    await writeFile(path.join(root, "secret.txt"), "secret");
    await symlink(path.join(root, "secret.txt"), path.join(folder, "link.txt"));
    const cases: Array<[string, string]> = [
      ["../secret.txt", "path must stay inside the upload folder"],
      [path.join(root, "secret.txt"), "path must be relative to the upload folder"],
      ["link.txt", "path must stay inside the upload folder"],
      ["missing.txt", "missing.txt was not found in the upload folder"],
      ["sub", "sub is not a regular file"],
    ];
    for (const [relative, message] of cases) {
      const result = await call(h.client, "send_message", { to: [BOB], topic: "t", body: "b", attachments: [{ filename: "a.txt", path: relative }] });
      expect(text(result), relative).toContain(message);
    }
    expect([...fake.messages.values()].filter((m) => m.from === ALICE)).toEqual([]);
  });

  it("points large base64 at the upload folder in instructions, results and the send_file prompt", async () => {
    expect(h.client.getInstructions()).toContain("For large files, give the file's path in the upload folder instead of its data.");
    expect(h.client.getInstructions()).not.toContain("upload URL");
    const big = Buffer.alloc(49_152, 1).toString("base64");
    const sent = await call(h.client, "send_message", { to: [BOB], topic: "t", body: "b",
      attachments: [{ filename: "big.bin", data_base64: big }, { filename: "small.bin", data_base64: "AAAA" }] });
    const hint = "big.bin went inline as base64. Next time, send files this large without writing their bytes: give their path in the upload folder instead of data_base64.";
    expect(structured(sent).hint).toBe(hint);
    expect(text(sent)).toContain(hint);
    const small = await call(h.client, "send_message", { to: [BOB], topic: "t", body: "b", attachments: [{ filename: "a.bin", data_base64: "AAAA" }] });
    expect(structured(small).hint).toBeUndefined();
    const prompt = await h.client.getPrompt({ name: "send_file", arguments: { files: "report.pdf", to: "bob" } });
    const steps = (prompt.messages[0]!.content as { text: string }).text;
    expect(steps).toContain("Send these files over fmsg: report.pdf.");
    expect(steps).toContain("1. Call send_message to bob, with a short topic");
    expect(steps).toContain("relative to the upload folder");
  });

  it("describes the path source only when the folder is configured", async () => {
    const { tools } = await h.client.listTools();
    const send = tools.find((t) => t.name === "send_message")!;
    expect(JSON.stringify(send.inputSchema)).toContain("upload folder");
    expect(send.description).toContain("an attachment path in the upload folder");
    expect(send.description).not.toContain("upload URL");
  });
});
