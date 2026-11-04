import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostTransport, hostFilename, isPublicAddress, prepareHostFiles, publicHttpsTransport } from "../src/host-files.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, type Harness, call, connectInMemory, structured, text } from "./helpers.js";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Serves fixed files by URL, like the host's file store; records what was fetched. */
function fakeFiles(files: Record<string, { body?: Uint8Array; status?: number; headers?: Record<string, string>; chunks?: Uint8Array[] }>) {
  const fetched: string[] = [];
  const transport: HostTransport = async (url) => {
    fetched.push(url.toString());
    const f = files[url.toString()];
    if (!f) return { status: 404, headers: {}, body: (async function* () {})(), cancel: () => undefined };
    const chunks = f.chunks ?? (f.body ? [f.body] : []);
    return {
      status: f.status ?? 200,
      headers: { ...(f.body ? { "content-length": String(f.body.byteLength) } : {}), ...f.headers },
      body: (async function* () { for (const c of chunks) yield c; })(),
      cancel: () => undefined,
    };
  };
  return { transport, fetched };
}

describe("public addresses", () => {
  it("allows only globally routable addresses", () => {
    for (const ok of ["8.8.8.8", "104.18.0.1", "2606:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"]) expect(isPublicAddress(ok), ok).toBe(true);
    for (const bad of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "not-an-ip",
    ]) expect(isPublicAddress(bad), bad).toBe(false);
  });
});

describe("host file names", () => {
  it("keeps safe names and makes the rest safe", () => {
    expect(hostFilename("9379.jpg", "image/jpeg")).toBe("9379.jpg");
    expect(hostFilename("Quarterly report (final).pdf", undefined)).toBe("Quarterly_report_final_.pdf");
    expect(hostFilename("../../etc/passwd", undefined)).toBe("passwd");
    expect(hostFilename(".hidden", undefined)).toBe("hidden");
    expect(hostFilename("café.png", undefined)).toBe("cafe_.png");
    expect(hostFilename(undefined, "image/png")).toBe("file.png");
    expect(hostFilename("", "application/x-unknown")).toBe("file");
    expect(hostFilename(`${"a".repeat(200)}.jpeg`, undefined)).toMatch(/^a{95}\.jpeg$/u);
  });
});

describe("downloads", () => {
  const signal = () => new AbortController().signal;
  const base = { maxBytes: 1024, allowedHosts: [] as string[] };

  it("refuses non-https, credentials, disallowed hosts and private addresses before fetching", async () => {
    const { transport, fetched } = fakeFiles({});
    const run = (url: string, opts = {}) => prepareHostFiles([{ download_url: url, file_id: "f1", file_name: "a.jpg" }], { ...base, transport, ...opts }, signal());
    await expect(run("http://files.example/a")).rejects.toThrow("file a.jpg: download refused (only https download URLs are accepted)");
    await expect(run("https://u:p@files.example/a")).rejects.toThrow("credentials in the URL are not accepted");
    await expect(run("https://evil.example/a", { allowedHosts: ["oaiusercontent.com"] })).rejects.toThrow("host evil.example is not an allowed file host");
    expect(fetched).toEqual([]);
    // The real transport: IP literals and names that resolve to loopback are refused.
    const real = (url: string) => prepareHostFiles([{ download_url: url, file_id: "f1", file_name: "a.jpg" }], base, signal());
    await expect(real("https://127.0.0.1/a")).rejects.toThrow("download refused (address not public)");
    await expect(real("https://[::1]/a")).rejects.toThrow("download refused (address not public)");
    await expect(real("https://169.254.169.254/latest")).rejects.toThrow("download refused (address not public)");
    await expect(real("https://localhost/a")).rejects.toThrow("download refused (address not public)");
    expect(publicHttpsTransport).toBeTypeOf("function");
  });

  it("follows a few redirects, each checked, and refuses one to http or a disallowed host", async () => {
    const data = Buffer.from("hello");
    const ok = fakeFiles({
      "https://a.example/1": { status: 302, headers: { location: "https://b.example/2" } },
      "https://b.example/2": { body: data },
    });
    const [got] = await prepareHostFiles([{ download_url: "https://a.example/1", file_id: "f", file_name: "h.txt" }], { ...base, transport: ok.transport }, signal());
    expect(Buffer.from(got!.data)).toEqual(data);
    expect(ok.fetched).toEqual(["https://a.example/1", "https://b.example/2"]);
    const toHttp = fakeFiles({ "https://a.example/1": { status: 301, headers: { location: "http://a.example/2" } } });
    await expect(prepareHostFiles([{ download_url: "https://a.example/1", file_id: "f", file_name: "h.txt" }], { ...base, transport: toHttp.transport }, signal()))
      .rejects.toThrow("download refused (only https download URLs are accepted)");
    const loop = fakeFiles({ "https://a.example/1": { status: 302, headers: { location: "https://a.example/1" } } });
    await expect(prepareHostFiles([{ download_url: "https://a.example/1", file_id: "f", file_name: "h.txt" }], { ...base, transport: loop.transport }, signal()))
      .rejects.toThrow("too many redirects");
  });

  it("enforces the size limit from Content-Length and from the stream, and refuses empty files and errors", async () => {
    const big = fakeFiles({ "https://a.example/big": { body: randomBytes(2048) } });
    await expect(prepareHostFiles([{ download_url: "https://a.example/big", file_id: "f", file_name: "b.bin" }], { ...base, transport: big.transport }, signal()))
      .rejects.toThrow("file b.bin is larger than 1 KiB");
    const sneaky = fakeFiles({ "https://a.example/s": { chunks: [randomBytes(700), randomBytes(700)] } });
    await expect(prepareHostFiles([{ download_url: "https://a.example/s", file_id: "f", file_name: "s.bin" }], { ...base, transport: sneaky.transport }, signal()))
      .rejects.toThrow("file s.bin is larger than 1 KiB");
    const empty = fakeFiles({ "https://a.example/e": { chunks: [] } });
    await expect(prepareHostFiles([{ download_url: "https://a.example/e", file_id: "f", file_name: "e.txt" }], { ...base, transport: empty.transport }, signal()))
      .rejects.toThrow("file e.txt is empty");
    const denied = fakeFiles({ "https://a.example/d": { status: 403 } });
    await expect(prepareHostFiles([{ download_url: "https://a.example/d", file_id: "f", file_name: "d.txt" }], { ...base, transport: denied.transport }, signal()))
      .rejects.toThrow("file d.txt: download failed: HTTP 403");
  });
});

describe("tools take files by reference", () => {
  let fake: FakeFmsgServer;
  let h: Harness;
  const jpeg = randomBytes(104_477);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(5000)]);
  let files: ReturnType<typeof fakeFiles>;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    files = fakeFiles({
      "https://files.example/jpeg": { body: jpeg, headers: { "content-type": "image/jpeg" } },
      "https://files.example/pdf": { body: pdf },
    });
    h = await connectInMemory(fake, undefined, {}, { hostTransport: files.transport });
  });
  afterEach(async () => {
    await h.close();
    await fake.stop();
  });

  it("declares openai/fileParams with OpenAI's file object shape on send_message, reply and create_draft", async () => {
    const tools = (await h.client.listTools()).tools;
    for (const name of ["send_message", "reply", "create_draft"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool._meta?.["openai/fileParams"], name).toEqual(["files"]);
      const prop = (tool.inputSchema.properties as Record<string, { type: string; items: { properties: Record<string, unknown>; required?: string[] } }>).files!;
      expect(prop.type).toBe("array");
      expect(Object.keys(prop.items.properties).sort()).toEqual(["download_url", "file_id", "file_name", "mime_type"]);
      expect([...(prop.items.required ?? [])].sort()).toEqual(["download_url", "file_id"]);
      expect(tool.inputSchema.required ?? []).not.toContain("files");
    }
  });

  it("downloads, attaches the exact bytes and reports each file's sha256", async () => {
    const sent = structured<{ id: string; files: Array<{ file_id: string; filename: string; size: number; sha256: string }>; attachments: Array<{ filename: string; type: string }> }>(
      await call(h.client, "send_message", {
        to: [BOB], topic: "photo", body: "here",
        files: [
          { download_url: "https://files.example/jpeg", file_id: "file-1", file_name: "9379.jpg" },
          { download_url: "https://files.example/pdf", file_id: "file-2", mime_type: "application/pdf" },
        ],
      }));
    const stored = fake.messages.get(sent.id)!;
    expect(stored.from).toBe(ALICE);
    expect(stored.time).not.toBeNull();
    const byName = Object.fromEntries(stored.attachments.map((a) => [a.filename, a.data]));
    expect(byName["9379.jpg"]).toEqual(jpeg);
    expect(byName["file.pdf"]).toEqual(pdf);
    expect(sent.files).toEqual([
      { file_id: "file-1", filename: "9379.jpg", size: jpeg.byteLength, sha256: sha256(jpeg) },
      { file_id: "file-2", filename: "file.pdf", size: pdf.byteLength, sha256: sha256(pdf) },
    ]);
    expect(sent.attachments.map((a) => a.type)).toEqual(["image/jpeg", "application/pdf"]);
  });

  it("works next to inline attachments, renames clashes, and on reply and create_draft", async () => {
    const draft = structured<{ draft_id: string; files: Array<{ filename: string }> }>(await call(h.client, "create_draft", {
      to: [BOB], topic: "t", body: "b",
      attachments: [{ filename: "9379.jpg", data_text: "not the photo" }],
      files: [{ download_url: "https://files.example/jpeg", file_id: "file-1", file_name: "9379.jpg" }],
    }));
    expect(draft.files.map((f) => f.filename)).toEqual(["9379-2.jpg"]);
    expect(fake.messages.get(draft.draft_id)!.attachments.map((a) => a.filename).sort()).toEqual(["9379-2.jpg", "9379.jpg"]);
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "q", data: "send me the pdf" }).id;
    const reply = structured<{ id: string; files: Array<{ sha256: string }> }>(await call(h.client, "reply", {
      id: root, body: "attached", files: [{ download_url: "https://files.example/pdf", file_id: "file-2", file_name: "report.pdf" }],
    }));
    expect(fake.messages.get(reply.id)!.attachments[0]!.data).toEqual(pdf);
    expect(reply.files[0]!.sha256).toBe(sha256(pdf));
  });

  it("creates nothing when a file can't be downloaded", async () => {
    const before = fake.messages.size;
    const res = await call(h.client, "send_message", {
      to: [BOB], topic: "t", body: "b",
      files: [{ download_url: "https://files.example/jpeg", file_id: "ok" }, { download_url: "https://files.example/missing", file_id: "gone", file_name: "x.png" }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("file x.png: download failed: HTTP 404");
    expect(fake.messages.size).toBe(before);
  });
});
