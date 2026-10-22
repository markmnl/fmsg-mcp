import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Caller } from "../src/context.js";
import { createHttpServer, type HttpServerHandle } from "../src/http.js";
import { PresignedLinks, localFileName, shellQuote } from "../src/links.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, call, configFor, structured, text } from "./helpers.js";
import { type Certificate, hasOpenssl, httpsFetch, selfSignedCertificate, tlsProxy } from "./tls.js";

const hasCurl = (() => { try { execFileSync("curl", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

type Presigned = { url: string; method: string; expires_at: string; size: number; sha256: string; curl: string };

describe.skipIf(!hasOpenssl())("presigned links", () => {
  let cert: Certificate;
  let certFile: string;
  let work: string;
  let fake: FakeFmsgServer;
  let http: HttpServerHandle;
  let proxy: Awaited<ReturnType<typeof tlsProxy>>;
  let client: Client;
  let raw: { http: (method: string, url: string, headers: Record<string, string>, body?: Uint8Array) => ReturnType<typeof httpsFetch> };

  beforeAll(() => {
    cert = selfSignedCertificate();
    work = mkdtempSync(path.join(os.tmpdir(), "fmsg-mcp-links-"));
    certFile = path.join(work, "ca.pem");
    writeFileSync(certFile, cert.cert);
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    let port = 0;
    proxy = await tlsProxy(cert, () => port);
    http = createHttpServer(configFor(fake, "http", { FMSG_MCP_PUBLIC_URL: `${proxy.origin}/mcp` }), () => undefined);
    await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve));
    port = (http.server.address() as AddressInfo).port;
    client = new Client({ name: "links-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: "Bearer fmsgk_alice_secret" } },
    }));
    // Requests to links send no Authorization header.
    raw = { http: (method, url, headers, body) => httpsFetch(cert.cert, method, url, headers, body) };
  });
  afterEach(async () => {
    vi.useRealTimers();
    await client.close();
    await http.close();
    await proxy.close();
    await fake.stop();
  });

  /** Run a returned curl command in a scratch folder, trusting the test certificate (async: the server runs in this process). */
  const curl = async (command: string, cwd: string) =>
    (await promisify(execFile)("sh", ["-c", command], { cwd, env: { ...process.env, CURL_CA_BUNDLE: certFile }, timeout: 10_000 })).stdout;

  describe("download", () => {
    const file = Buffer.from("presigned download bytes");
    let message: ReturnType<FakeFmsgServer["seed"]>;
    const link = async () => structured<{ presigned: Presigned }>(await call(client, "get_attachment_download_url", { id: message.id, filename: "report v1.txt", presigned: true })).presigned;
    beforeEach(() => { message = fake.seed({ from: BOB, to: [ALICE], topic: "files", attachments: [{ filename: "report v1.txt", data: file }] }); });

    it("returns a single-use GET link with its size, sha256, expiry and curl command", async () => {
      const result = await call(client, "get_attachment_download_url", { id: message.id, filename: "report v1.txt", presigned: true });
      const presigned = structured<{ presigned: Presigned; download_url: string }>(result).presigned;
      expect(presigned).toMatchObject({ method: "GET", size: file.byteLength, sha256: sha256(file) });
      expect(presigned.url.startsWith(`${proxy.origin}/mcp/links/`)).toBe(true);
      expect(Date.parse(presigned.expires_at) - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(presigned.curl).toBe(`curl -fsS -o 'report_v1.txt' ${shellQuote(presigned.url)}`);
      expect(text(result)).toContain(presigned.curl);
      // The link is no credential: neither the API key nor an access token appears in it.
      expect(presigned.url).not.toContain("fmsgk_");
      const plain = structured<Record<string, unknown>>(await call(client, "get_attachment_download_url", { id: message.id, filename: "report v1.txt" }));
      expect(plain.presigned).toBeUndefined();
    });

    it.skipIf(!hasCurl)("downloads once with the curl command and no Authorization header", async () => {
      const presigned = await link();
      const dir = mkdtempSync(path.join(work, "get-"));
      await curl(presigned.curl, dir);
      expect(readFileSync(path.join(dir, "report_v1.txt"))).toEqual(file);
      await expect(curl(presigned.curl, dir)).rejects.toThrow();
      const again = await raw.http("GET", presigned.url, {});
      expect(again.status).toBe(409);
      expect(again.body.toString()).toContain("already used");
    });

    it("refuses tampered, expired and wrong-method requests", async () => {
      const presigned = await link();
      const tampered = `${presigned.url.slice(0, -1)}${presigned.url.endsWith("A") ? "B" : "A"}`;
      expect((await raw.http("GET", tampered, {})).status).toBe(404);
      expect((await raw.http("PUT", presigned.url, {}, file)).status).toBe(405);
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 6 * 60_000 });
      const late = await raw.http("GET", presigned.url, {});
      expect(late.status).toBe(410);
      expect(late.body.toString()).toContain("expired");
    });

    it("never delivers an attachment that changed after the link was issued", async () => {
      const presigned = await link();
      message.attachments[0]!.data = Buffer.from("presigned download BYTES");
      const changed = await raw.http("GET", presigned.url, {});
      expect(changed.status).toBe(409);
      expect(changed.body.toString()).toContain("changed since this link was issued");
    });

    it("cuts a large changed attachment off before its last bytes", async () => {
      const large = Buffer.alloc(2 * 1024 * 1024, 3);
      message.attachments[0]!.data = large;
      message.attachments[0]!.size = large.byteLength;
      const presigned = await link();
      const altered = Buffer.from(large);
      altered[altered.length - 1] = 4;
      message.attachments[0]!.data = altered;
      const received = await raw.http("GET", presigned.url, {}).then((r) => r.body.byteLength, () => -1);
      // Either the transfer fails, or it ends short: the client never holds all the declared bytes.
      expect(received).not.toBe(large.byteLength);
    });
  });

  describe("upload", () => {
    const file = Buffer.from("presigned upload bytes");
    const draft = async () => structured<{ draft_id: string }>(await call(client, "create_draft", { to: [BOB], topic: "t", body: "b" })).draft_id;
    const link = async (id: string, extra: Record<string, unknown> = {}) =>
      structured<Presigned & { draft_id: string }>(await call(client, "get_attachment_upload_url", { id, filename: "up.bin", size: file.byteLength, sha256: sha256(file), ...extra }));

    it.skipIf(!hasCurl)("uploads with the curl command and no Authorization header, then send_draft sends it", async () => {
      const id = await draft();
      const presigned = await link(id);
      expect(presigned).toMatchObject({ draft_id: id, method: "PUT", size: file.byteLength, sha256: sha256(file) });
      expect(presigned.curl).toBe(`curl -fsS -X PUT --data-binary @'up.bin' ${shellQuote(presigned.url)}`);
      const dir = mkdtempSync(path.join(work, "put-"));
      writeFileSync(path.join(dir, "up.bin"), file);
      const answer = JSON.parse(await curl(presigned.curl, dir)) as { filename: string; size: number; sha256: string };
      expect(answer).toEqual({ filename: "up.bin", size: file.byteLength, sha256: sha256(file) });
      await expect(curl(presigned.curl, dir)).rejects.toThrow();
      structured(await call(client, "send_draft", { id }));
      expect(fake.messages.get(id)!.attachments.map((a) => [a.filename, a.data.toString()])).toEqual([["up.bin", file.toString()]]);
    });

    it("accepts only the declared size and sha256, and one successful upload", async () => {
      const id = await draft();
      const { url } = await link(id);
      expect((await raw.http("PUT", url, {}, Buffer.concat([file, Buffer.from("!")]))).status).toBe(413);
      const wrong = await raw.http("PUT", url, {}, Buffer.from("presigned upload BYTES"));
      expect(wrong.status).toBe(422);
      expect(wrong.body.toString()).toContain(`do not match the declared sha256 ${sha256(file)}`);
      expect((await raw.http("GET", url, {})).status).toBe(405);
      expect((await raw.http("PUT", url, {}, file)).status).toBe(201);
      expect((await raw.http("PUT", url, {}, file)).status).toBe(409);
      expect(fake.messages.get(id)!.attachments).toHaveLength(1);
    });

    it("is refused for sent messages, other people's drafts and names already taken", async () => {
      const sent = fake.seed({ from: ALICE, to: [BOB], topic: "sent", data: "x" });
      expect(text(await call(client, "get_attachment_upload_url", { id: sent.id, filename: "a.bin", size: 1, sha256: "0".repeat(64) }))).toContain("already sent");
      const theirs = fake.seed({ from: BOB, to: [ALICE], topic: "draft", data: "x", time: null });
      expect(text(await call(client, "get_attachment_upload_url", { id: theirs.id, filename: "a.bin", size: 1, sha256: "0".repeat(64) }))).toContain("not your draft");
      const id = await draft();
      await raw.http("PUT", (await link(id)).url, {}, file);
      expect(text(await call(client, "get_attachment_upload_url", { id, filename: "up.bin", size: 1, sha256: "0".repeat(64) }))).toContain("already has an attachment named up.bin");
    });
  });

  it("names the presigned route only where it is registered", async () => {
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === "get_attachment_upload_url")).toBe(true);
    expect(tools.find((t) => t.name === "create_draft")!.description).toContain("get_attachment_upload_url");
    expect(JSON.stringify(tools.find((t) => t.name === "get_attachment_download_url")!.inputSchema)).toContain("presigned");
  });
});

describe("PresignedLinks", () => {
  const caller = { address: ALICE } as Caller;
  it("works only on the instance that issued it, even with a shared key", () => {
    const secret = "k".repeat(32);
    const one = new PresignedLinks("https://mcp.example.com/mcp", secret);
    const two = new PresignedLinks("https://mcp.example.com/mcp", secret);
    const { url } = one.mint(caller, { k: "get", m: "1", n: "a.bin", s: 1, h: "0".repeat(64) });
    const token = url.slice(url.lastIndexOf("/") + 1);
    expect(one.resolve(token, "GET")).toMatchObject({ caller });
    expect(two.resolve(token, "GET")).toMatchObject({ status: 404, error: expect.stringContaining("another server instance") });
    expect(new PresignedLinks("https://mcp.example.com/mcp", undefined).resolve(token, "GET")).toEqual({ status: 404, error: "unknown link" });
    one.close(); two.close();
  });

  it("quotes curl arguments and local names safely", () => {
    expect(shellQuote("it's $(x)")).toBe(`'it'\\''s $(x)'`);
    expect(localFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(localFileName("Ünïcode ñame.pdf")).toBe("Unicode_name.pdf");
  });
});
