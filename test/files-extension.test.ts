import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpServer, type HttpServerHandle } from "../src/http.js";
import { FILES_EXTENSION } from "../src/files/extension.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { FILES, FilesClient, type RpcResponse, type UploadTarget, digestOf, fileInput } from "./files-client.js";
import { ALICE, BOB, CAROL, configFor, connectInMemory } from "./helpers.js";
import { type Certificate, hasOpenssl, selfSignedCertificate, tlsProxy } from "./tls.js";

const bytes = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const big = new Uint8Array(Buffer.alloc(300_000, 7));
const textOf = (reply: RpcResponse) => ((reply.result?.content as Array<{ text?: string }> | undefined) ?? []).map((c) => c.text ?? "").join("\n");
const structuredOf = <T = Record<string, unknown>>(reply: RpcResponse) => reply.result?.structuredContent as T;

describe.skipIf(!hasOpenssl())("MCP file-uploads extension over HTTPS", () => {
  let cert: Certificate;
  let fake: FakeFmsgServer;
  let http: HttpServerHandle;
  let proxy: Awaited<ReturnType<typeof tlsProxy>>;
  let alice: FilesClient;
  let mcpUrl: string;

  async function start(extra: Record<string, string> = {}) {
    let port = 0;
    proxy = await tlsProxy(cert, () => port);
    mcpUrl = `${proxy.origin}/mcp`;
    http = createHttpServer(configFor(fake, "http", { FMSG_MCP_PUBLIC_URL: mcpUrl, ...extra }), () => undefined);
    await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve));
    port = (http.server.address() as AddressInfo).port;
    alice = clientFor("fmsgk_alice_secret");
  }
  const clientFor = (bearer: string) => new FilesClient({ mcpUrl, bearer, ca: cert.cert, allowAddresses: ["127.0.0.1"] });

  beforeEach(async () => {
    cert ??= selfSignedCertificate();
    fake = new FakeFmsgServer();
    await fake.start();
    await start();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await http.close();
    await proxy.close();
    await fake.stop();
  });

  const attachmentsOf = (id: string) => fake.messages.get(id)!.attachments.map((a) => ({ filename: a.filename, data: a.data.toString("utf8"), type: a.type }));
  const drafts = () => [...fake.messages.values()].filter((m) => m.time === null && !m.deleted);

  /** The initial call: answers input_required with upload targets. */
  async function initial(name: string, args: Record<string, unknown>) {
    const reply = await alice.rpc("tools/call", { name, arguments: args });
    expect(reply.result?.resultType, JSON.stringify(reply)).toBe("input_required");
    const uploads = (reply.result!.inputRequests as Record<string, { method: string; params: { files: UploadTarget[] } }>).uploads!;
    return { state: reply.result!.requestState as string, targets: uploads.params.files, uploads };
  }
  const retry = (name: string, args: Record<string, unknown>, state: string, files: Array<{ fileId: string; status: string }>, client = alice) =>
    client.rpc("tools/call", { name, arguments: args, requestState: state, inputResponses: { uploads: { resultType: "complete", files } } });

  describe("end to end", () => {
    it("advertises the extension and marks FileInputs with x-mcp-file", async () => {
      expect(await alice.discover()).toEqual({ maxInlineBytes: 1024 * 1024 });
      const tools = (await alice.rpc("tools/list", {})).result!.tools as Array<{ name: string; inputSchema: { properties: Record<string, { items?: { anyOf?: Array<Record<string, unknown>> } }> } }>;
      for (const name of ["send_message", "reply", "create_draft"]) {
        const items = tools.find((t) => t.name === name)!.inputSchema.properties.attachments!.items!;
        const marked = items.anyOf!.find((s) => "x-mcp-file" in s)!;
        expect(marked.required).toEqual(expect.arrayContaining(["id", "mimeType", "size", "digest"]));
        expect(items.anyOf!.some((s) => (s.required as string[] | undefined)?.includes("filename"))).toBe(true);
      }
    });

    it("sends a message with out-of-band, inline and classic attachments in one call", async () => {
      const pdf = big;
      const csv = bytes("a,b\n1,2\n");
      const note = bytes("inline note");
      const args = {
        to: [BOB], topic: "Q3", body: "files attached",
        attachments: [
          fileInput("file-1", "Q3 report.pdf", "application/pdf", pdf),
          fileInput("file-2", "data.csv", "text/csv", csv),
          fileInput("file-3", "note.txt", "text/plain", note, true),
          { filename: "readme.txt", data_text: "classic" },
        ],
      };
      const { reply, rounds } = await alice.callWithFiles("send_message", args, { "file-1": pdf, "file-2": csv });
      expect(reply.result?.isError, textOf(reply)).toBeFalsy();
      const sent = structuredOf<{ id: string; attachments: Array<{ filename: string; size: number; type: string }> }>(reply);
      expect(textOf(reply)).toContain(`Sent message ${sent.id} "Q3"`);
      expect(sent.attachments.map((a) => a.filename)).toEqual(["Q3_report.pdf", "data.csv", "note.txt", "readme.txt"]);
      expect(sent.attachments.find((a) => a.filename === "Q3_report.pdf")).toMatchObject({ size: pdf.byteLength, type: "application/pdf" });
      const stored = fake.messages.get(sent.id)!;
      expect(stored.time).not.toBeNull();
      expect(Buffer.compare(stored.attachments.find((a) => a.filename === "Q3_report.pdf")!.data, Buffer.from(pdf))).toBe(0);
      expect(attachmentsOf(sent.id).find((a) => a.filename === "data.csv")).toMatchObject({ data: "a,b\n1,2\n", type: "text/csv" });

      // One round, one target per file without data, each same-origin https, credential-bearing and single-use.
      expect(rounds).toHaveLength(1);
      const targets = rounds[0]!.targets;
      expect(targets.map((t) => t.fileId)).toEqual(["file-1", "file-2"]);
      for (const t of targets) {
        expect(new URL(t.url).origin).toBe(proxy.origin);
        expect(new URL(t.url).pathname.startsWith("/mcp/uploads/")).toBe(true);
        expect(t.credentials).toBe("include");
      }
      expect(targets[0]!.headers).toEqual({ "Content-Type": "application/pdf" });
      expect(alice.log.filter((r) => r.method === "PUT").map((r) => [r.status, r.authorization])).toEqual([[201, true], [201, true]]);
      // The result does not echo upload URLs.
      expect(JSON.stringify(reply)).not.toContain("/mcp/uploads/");
      expect(drafts()).toEqual([]);
    });

    it("replies with an uploaded file", async () => {
      const parent = fake.seed({ from: BOB, to: [ALICE], topic: "Plans", data: "send me the file" });
      const file = bytes("the file");
      const { reply } = await alice.callWithFiles("reply", { id: parent.id, body: "here", attachments: [fileInput("f", "plan.md", "text/markdown", file)] }, { f: file });
      const sent = structuredOf<{ id: string; parent_id: string; to: string[]; thread_topic: string }>(reply);
      expect(sent).toMatchObject({ parent_id: parent.id, to: [BOB], thread_topic: "Plans" });
      expect(attachmentsOf(sent.id)).toEqual([{ filename: "plan.md", data: "the file", type: "text/markdown" }]);
    });

    it("creates a draft with an uploaded file and leaves it unsent", async () => {
      const file = bytes("draft file");
      const { reply } = await alice.callWithFiles("create_draft", { to: [CAROL], topic: "Later", body: "b", attachments: [fileInput("f", "x.bin", "application/octet-stream", file)] }, { f: file });
      const draft = structuredOf<{ draft_id: string; attachments: Array<{ filename: string }> }>(reply);
      expect(draft.attachments.map((a) => a.filename)).toEqual(["x.bin"]);
      expect(fake.messages.get(draft.draft_id)!.time).toBeNull();
      expect(textOf(reply)).toContain(`Created draft ${draft.draft_id}`);
    });
  });

  describe("checks on the initial call", () => {
    it.each([
      ["duplicate ids", [fileInput("a", "one.txt", "text/plain", bytes("1")), fileInput("a", "two.txt", "text/plain", bytes("2"))], 'file "a": id is used by more than one file'],
      ["a digest algorithm other than sha-256", [{ ...fileInput("a", "x.txt", "text/plain", bytes("1")), digest: { algorithm: "md5", value: digestOf(bytes("1")).value } }], "digest algorithm must be sha-256"],
      ["a malformed digest", [{ ...fileInput("a", "x.txt", "text/plain", bytes("1")), digest: { algorithm: "sha-256", value: "abc" } }], "base64url SHA-256 without padding"],
      ["a malformed media type", [fileInput("a", "x.txt", "not a type", bytes("1"))], "is not a media type"],
      ["colliding names", [fileInput("a", "same.txt", "text/plain", bytes("1")), fileInput("b", "same.txt", "text/plain", bytes("2"))], "already named same.txt"],
      ["inline data that does not match its digest", [{ ...fileInput("a", "x.txt", "text/plain", bytes("one"), true), digest: digestOf(bytes("two")) }], "does not match its digest"],
      ["inline data that does not match its size", [{ ...fileInput("a", "x.txt", "text/plain", bytes("one"), true), size: 4 }], "decodes to 3 bytes but size is 4"],
    ])("refuses %s before creating anything", async (_name, attachments, message) => {
      const reply = await alice.rpc("tools/call", { name: "send_message", arguments: { to: [BOB], topic: "t", body: "b", attachments } });
      expect(reply.result?.isError).toBe(true);
      expect(textOf(reply)).toContain(message);
      expect(textOf(reply)).toContain("Nothing was sent");
      expect(fake.messages.size).toBe(0);
    });

    it("refuses files over the operator's size limit and inline data over maxInlineBytes", async () => {
      await http.close(); await proxy.close();
      await start({ FMSG_MCP_FILES_MAX_FILE_BYTES: "1000", FMSG_MCP_FILES_MAX_INLINE_BYTES: "10" });
      expect(await alice.discover()).toEqual({ maxInlineBytes: 10 });
      const tooBig = await alice.rpc("tools/call", { name: "send_message", arguments: { to: [BOB], topic: "t", body: "b", attachments: [fileInput("a", "x.bin", "application/octet-stream", big)] } });
      expect(textOf(tooBig)).toContain("300000 bytes is larger than this server's limit of 1000 bytes per file");
      const inline = await alice.rpc("tools/call", { name: "send_message", arguments: { to: [BOB], topic: "t", body: "b", attachments: [fileInput("a", "x.txt", "text/plain", bytes("more than ten bytes"), true)] } });
      expect(textOf(inline)).toContain("maxInlineBytes (10)");
      expect(fake.messages.size).toBe(0);
    });

    it("sends inline FileInputs without an upload round, even when the request did not declare the extension", async () => {
      const reply = await alice.rpc("tools/call", { name: "send_message", arguments: { to: [BOB], topic: "t", body: "b", attachments: [fileInput("a", "x.txt", "text/plain", bytes("hi"), true)] } }, false);
      expect(reply.result?.resultType).toBe("complete");
      expect(attachmentsOf(structuredOf<{ id: string }>(reply).id)).toEqual([{ filename: "x.txt", data: "hi", type: "text/plain" }]);
    });

    it("refuses a file without data when the request did not declare the extension", async () => {
      const reply = await alice.rpc("tools/call", { name: "send_message", arguments: { to: [BOB], topic: "t", body: "b", attachments: [fileInput("a", "x.txt", "text/plain", bytes("hi"))] } }, false);
      expect(reply.result?.isError).toBe(true);
      expect(textOf(reply)).toContain(`did not declare the ${FILES_EXTENSION} extension`);
      expect(fake.messages.size).toBe(0);
    });

    it("keeps the tool's own checks ahead of the files", async () => {
      const terminal = fake.seed({ from: BOB, to: [ALICE], data: "end", terminal: true });
      const reply = await alice.rpc("tools/call", { name: "reply", arguments: { id: terminal.id, body: "x", attachments: [fileInput("a", "x.txt", "text/plain", bytes("hi"))] } });
      expect(textOf(reply)).toContain("terminal");
      expect(drafts()).toEqual([]);
    });
  });

  describe("upload targets", () => {
    const args = (file: Uint8Array) => ({ to: [BOB], topic: "t", body: "b", attachments: [fileInput("f", "f.bin", "application/octet-stream", file)] });

    it("enforce the declared size and digest, and take one upload", async () => {
      const file = bytes("exact bytes");
      const { targets } = await initial("send_message", args(file));
      const url = targets[0]!.url;
      const auth = { authorization: "Bearer fmsgk_alice_secret" };
      expect((await alice.http("PUT", url, auth, bytes("exact bytes and more"))).status).toBe(413);
      expect((await alice.http("PUT", url, auth, bytes("short"))).status).toBe(400);
      const wrong = await alice.http("PUT", url, auth, bytes("other bytes"));
      expect(wrong.status).toBe(422);
      expect(wrong.body.toString()).toContain("do not match the file's declared digest");
      expect((await alice.http("PUT", url, auth, file)).status).toBe(201);
      const again = await alice.http("PUT", url, auth, file);
      expect(again.status).toBe(409);
      expect(again.body.toString()).toContain("already used");
      expect(drafts()[0]!.attachments.map((a) => a.filename)).toEqual(["f.bin"]);
    });

    it("need the credential of the address they were issued to", async () => {
      const file = bytes("x");
      const { targets } = await initial("send_message", args(file));
      expect((await alice.http("PUT", targets[0]!.url, {}, file)).status).toBe(401);
      const bob = await alice.http("PUT", targets[0]!.url, { authorization: "Bearer fmsgk_bob_secret" }, file);
      expect(bob.status).toBe(403);
      expect(bob.body.toString()).toContain("issued to another fmsg address");
      const url = targets[0]!.url;
      const tampered = `${url.slice(0, -1)}${url.endsWith("A") ? "B" : "A"}`;
      expect((await alice.http("PUT", tampered, { authorization: "Bearer fmsgk_alice_secret" }, file)).status).toBe(404);
    });

    it("expire, and a retry after expiry ends the call and discards its draft", async () => {
      const file = bytes("late");
      const { targets, state } = await initial("send_message", args(file));
      expect(drafts()).toHaveLength(1);
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000 });
      const late = await alice.http("PUT", targets[0]!.url, { authorization: "Bearer fmsgk_alice_secret" }, file);
      expect(late.status).toBe(410);
      expect(late.body.toString()).toContain("expired");
      const reply = await retry("send_message", args(file), state, [{ fileId: "f", status: "completed" }]);
      expect(reply.result?.isError).toBe(true);
      expect(textOf(reply)).toContain("upload targets for this send_message call expired");
      expect(textOf(reply)).toContain("without requestState to get new targets");
      expect(drafts()).toEqual([]);
    });
  });

  describe("retries", () => {
    const file = bytes("payload");
    const args = { to: [BOB], topic: "t", body: "b", attachments: [fileInput("f", "f.txt", "text/plain", file)] };
    const put = (url: string) => alice.http("PUT", url, { authorization: "Bearer fmsgk_alice_secret" }, file);

    it("end the call and discard the draft when a file failed", async () => {
      const { reply } = await alice.callWithFiles("send_message", args, { f: file }, { failUpload: ["f"] });
      expect(reply.result?.isError).toBe(true);
      expect(textOf(reply)).toContain('reported that "f" could not be uploaded');
      expect(drafts()).toEqual([]);
      expect([...fake.messages.values()].filter((m) => m.time !== null)).toEqual([]);
    });

    it("explain an early retry and let the client upload and retry again", async () => {
      const { targets, state } = await initial("send_message", args);
      const early = await retry("send_message", args, state, [{ fileId: "f", status: "completed" }]);
      expect(early.result?.isError).toBe(true);
      expect(textOf(early)).toContain("has not received its bytes. PUT each file to its upload target first");
      expect((await put(targets[0]!.url)).status).toBe(201);
      const done = await retry("send_message", args, state, [{ fileId: "f", status: "completed" }]);
      expect(done.result?.isError, textOf(done)).toBeFalsy();
      expect(attachmentsOf(structuredOf<{ id: string }>(done).id)).toEqual([{ filename: "f.txt", data: "payload", type: "text/plain" }]);
    });

    it("never run a call twice", async () => {
      const { targets, state } = await initial("send_message", args);
      await put(targets[0]!.url);
      const outcome = [{ fileId: "f", status: "completed" }];
      const [first, second] = await Promise.all([retry("send_message", args, state, outcome), retry("send_message", args, state, outcome)]);
      const errors = [first, second].filter((r) => r.result?.isError);
      expect(errors).toHaveLength(1);
      expect(textOf(errors[0]!)).toMatch(/already (being completed|completed)/u);
      const third = await retry("send_message", args, state, outcome);
      expect(textOf(third)).toContain("already completed (message");
      expect([...fake.messages.values()].filter((m) => m.time !== null)).toHaveLength(1);
    });

    it("refuse different arguments, another tool, and malformed outcomes", async () => {
      const { targets, state } = await initial("send_message", args);
      await put(targets[0]!.url);
      const changed = await retry("send_message", { ...args, body: "changed" }, state, [{ fileId: "f", status: "completed" }]);
      expect(textOf(changed)).toContain("arguments differ from the send_message call");
      const other = await retry("create_draft", args, state, [{ fileId: "f", status: "completed" }]);
      expect(textOf(other)).toContain("issued by send_message, not create_draft");
      for (const [files, message] of [
        [[{ fileId: "g", status: "completed" }], 'unknown file "g"'],
        [[{ fileId: "f", status: "completed" }, { fileId: "f", status: "completed" }], 'more than one upload outcome for file "f"'],
        [[{ fileId: "f", status: "done" }], 'status "done"'],
      ] as const) {
        const reply = await retry("send_message", args, state, [...files]);
        expect(reply.result?.isError).toBe(true);
        expect(textOf(reply)).toContain(message);
      }
      // None of these ran the tool; the real retry still can.
      const done = await retry("send_message", args, state, [{ fileId: "f", status: "completed" }]);
      expect(done.result?.isError, textOf(done)).toBeFalsy();
    });

    it("stay retryable after a transient host error, and end with the draft deleted when the host refuses the send", async () => {
      const { targets, state } = await initial("send_message", args);
      await put(targets[0]!.url);
      const outcome = [{ fileId: "f", status: "completed" }];
      const draftId = drafts()[0]!.id;
      fake.failNext = { match: new RegExp(`^GET /fmsg/${draftId}$`, "u"), status: 502, error: "upstream unavailable" };
      const transient = await retry("send_message", args, state, outcome);
      expect(transient.result?.isError).toBe(true);
      expect(textOf(transient)).toContain("HTTP 502");
      fake.failNext = { match: /\/send$/u, status: 429, error: "daily message limit reached", code: "send_count_per_1d_limit" };
      const refused = await retry("send_message", args, state, outcome);
      expect(textOf(refused)).toContain("daily message limit reached");
      expect(drafts()).toEqual([]);
      const after = await retry("send_message", args, state, outcome);
      expect(textOf(after)).toContain("already ended");
    });

    it("ask again with the same targets when outcomes are missing", async () => {
      const { targets, state } = await initial("send_message", args);
      const again = await alice.rpc("tools/call", { name: "send_message", arguments: args, requestState: state });
      expect(again.result?.resultType).toBe("input_required");
      const reissued = (again.result!.inputRequests as Record<string, { params: { files: UploadTarget[] } }>).uploads!.params.files;
      expect(reissued.map((t) => t.url)).toEqual(targets.map((t) => t.url));
      expect(drafts()).toHaveLength(1);
    });

    it("reject requestState that was altered or belongs to another address with -32602", async () => {
      const { state } = await initial("send_message", args);
      const [version, body, mac] = state.split(".");
      const altered = `${version}.${body}.${mac!.slice(0, -2)}${mac!.endsWith("AA") ? "BB" : "AA"}`;
      const tampered = await retry("send_message", args, altered, [{ fileId: "f", status: "completed" }]);
      expect(tampered.error).toMatchObject({ code: -32602, message: "Invalid or expired requestState" });
      const bob = await retry("send_message", args, state, [{ fileId: "f", status: "completed" }], clientFor("fmsgk_bob_secret"));
      expect(bob.error).toMatchObject({ code: -32602 });
    });
  });
});

describe("file-uploads extension availability", () => {
  it("is not offered over stdio, which has no upload targets", async () => {
    const fake = new FakeFmsgServer();
    await fake.start();
    const h = await connectInMemory(fake);
    try {
      const tools = (await h.client.listTools()).tools;
      expect(JSON.stringify(tools)).not.toContain("x-mcp-file");
      expect(h.client.getServerCapabilities()?.extensions?.[FILES_EXTENSION]).toBeUndefined();
    } finally {
      await h.close();
      await fake.stop();
    }
  });

  it("needs an https public URL, and can be switched off", async () => {
    const fake = new FakeFmsgServer();
    await fake.start();
    try {
      expect(configFor(fake, "http", { FMSG_MCP_PUBLIC_URL: "http://127.0.0.1:1/mcp" }).files).toBeUndefined();
      expect(configFor(fake, "http", { FMSG_MCP_PUBLIC_URL: "https://mcp.example.com/mcp" }).files).toMatchObject({ maxInlineBytes: 1048576, targetTtlSeconds: 600 });
      expect(configFor(fake, "http", { FMSG_MCP_PUBLIC_URL: "https://mcp.example.com/mcp", FMSG_MCP_FILES_EXTENSION: "off" }).files).toBeUndefined();
      expect(() => configFor(fake, "http", { FMSG_MCP_PUBLIC_URL: "https://mcp.example.com/mcp", FMSG_MCP_STATE_SECRET: "short" })).toThrow("at least 32 bytes");
    } finally {
      await fake.stop();
    }
  });
});
