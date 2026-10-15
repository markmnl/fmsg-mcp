import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { deflateSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHttpServer, type HttpServerHandle } from "../src/http.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { BOB, call, configFor, structured } from "./helpers.js";

const PUBLIC = "https://mcp.example.com/mcp";
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("HTTP attachment uploads", () => {
  let fake: FakeFmsgServer;
  let http: HttpServerHandle;
  let base: string;
  let client: Client;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    http = createHttpServer(configFor(fake, "http", { FMSG_MCP_PUBLIC_URL: PUBLIC }), () => undefined);
    await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: "Bearer fmsgk_alice_secret" } },
    });
    client = new Client({ name: "upload-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
  });
  afterEach(async () => {
    await client.close().catch(() => undefined);
    await http.close();
    await fake.stop();
  });

  /** Create a draft over MCP and return a function building local upload URLs from its template. */
  async function draft(): Promise<{ id: string; url: (filename: string) => string }> {
    const created = structured<{ draft_id: string; upload: { url_template: string; method: string; checksum_header: string; accepts_encoding: string[] }; next: string }>(
      await call(client, "create_draft", { to: [BOB], topic: "files", body: "see attached" }));
    expect(created.upload).toEqual({
      url_template: `${PUBLIC}/drafts/${created.draft_id}/attachments/{filename}`, method: "PUT", authentication: "bearer",
      checksum_header: "x-content-sha256", accepts_encoding: ["gzip", "deflate"],
    });
    expect(created.next).toContain("then call send_draft");
    return { id: created.draft_id, url: (filename) => `${base}${new URL(created.upload.url_template.replace("{filename}", filename)).pathname}` };
  }

  const put = (url: string, body: BodyInit | undefined, headers: Record<string, string> = {}, key = "fmsgk_alice_secret") =>
    fetch(url, { method: "PUT", body, headers: { authorization: `Bearer ${key}`, ...headers } });

  it("streams a binary upload into the draft byte for byte, then sends it", async () => {
    const { id, url } = await draft();
    const bytes = randomBytes(3 * 1024 * 1024);
    // curl --data-binary labels the body as form data; the file's type comes from its name instead.
    const response = await put(url("photo.png"), bytes, { "content-type": "application/x-www-form-urlencoded", "x-content-sha256": sha256(bytes).toUpperCase() });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id, filename: "photo.png", size: bytes.byteLength, sha256: sha256(bytes), type: "image/png" });
    const stored = fake.messages.get(id)!.attachments[0]!;
    expect(stored.data.equals(bytes)).toBe(true);
    expect(stored.type).toBe("image/png");

    const sent = structured<{ id: string; attachments: Array<{ filename: string; size: number }> }>(await call(client, "send_draft", { id }));
    expect(sent.attachments).toEqual([{ filename: "photo.png", size: bytes.byteLength, type: "image/png" }]);
  });

  it("refuses a checksum mismatch and keeps nothing", async () => {
    const { id, url } = await draft();
    const response = await put(url("a.bin"), Buffer.from("abc"), { "x-content-sha256": "0".repeat(64) });
    expect(response.status).toBe(422);
    expect((await response.json() as { error: string }).error).toContain(`sha256 mismatch (expected ${"0".repeat(64)}, got ${sha256(Buffer.from("abc"))})`);
    expect(fake.messages.get(id)!.attachments).toEqual([]);
    const malformed = await put(url("a.bin"), Buffer.from("abc"), { "x-content-sha256": "abc" });
    expect(malformed.status).toBe(400);
  });

  it("decodes gzip and deflate uploads and refuses other or corrupt encodings", async () => {
    const { id, url } = await draft();
    const original = Buffer.from("line of text\n".repeat(5000));
    for (const [encoding, body] of [["gzip", gzipSync(original)], ["deflate", deflateSync(original)]] as const) {
      const response = await put(url(`${encoding}.txt`), body, { "content-encoding": encoding, "x-content-sha256": sha256(original) });
      expect(response.status, encoding).toBe(201);
      expect(await response.json()).toMatchObject({ size: original.byteLength, sha256: sha256(original) });
    }
    expect(fake.messages.get(id)!.attachments.map((a) => a.data.equals(original))).toEqual([true, true]);

    const brotli = await put(url("b.txt"), original, { "content-encoding": "br" });
    expect(brotli.status).toBe(415);
    const truncated = await put(url("t.txt"), gzipSync(original).subarray(0, 40), { "content-encoding": "gzip" });
    expect(truncated.status).toBe(400);
    expect((await truncated.json() as { error: string }).error).toContain("gzip request body is invalid or truncated");
    expect(fake.messages.get(id)!.attachments).toHaveLength(2);
  });

  it("checks method, path, query, credentials, ownership and origin", async () => {
    const { id, url } = await draft();
    expect((await fetch(url("a.txt"), { method: "PUT", body: "x" })).status).toBe(401);
    expect((await put(url("a.txt"), "x", {}, "fmsgk_wrong")).status).toBe(401);
    expect((await fetch(url("a.txt"), { headers: { authorization: "Bearer fmsgk_alice_secret" } })).status).toBe(405);
    expect((await put(`${url("a.txt")}?access_token=x`, "x")).status).toBe(400);
    expect((await put(`${base}/mcp/drafts/${id}/attachments/a%2Fb.txt`, "x")).status).toBe(400);
    expect((await put(`${base}/mcp/drafts/${id}/files/a.txt`, "x")).status).toBe(400);
    expect((await put(`${base}/mcp/drafts/abc/attachments/a.txt`, "x")).status).toBe(400);
    const other = await put(url("a.txt"), "x", {}, "fmsgk_bob_secret");
    expect(other.status).toBe(403);
    expect((await other.json() as { error: string }).error).toContain("not the owner");
    expect((await put(url("a.txt"), "x", {}, "fmsgk_carol_secret")).status).toBe(404);
    expect((await put(url("a.txt"), "x", { origin: "https://evil.example" })).status).toBe(403);
    expect(fake.messages.get(id)!.attachments).toEqual([]);

    const preflight = await fetch(url("a.txt"), { method: "OPTIONS", headers: {
      origin: base, "access-control-request-method": "PUT", "access-control-request-headers": "authorization, content-encoding, x-content-sha256",
    } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("PUT");
  });

  it("points large files at create_draft and offers no local path over HTTP", async () => {
    const { tools } = await client.listTools();
    const send = tools.find((t) => t.name === "send_message")!;
    expect(send.description).toContain("For large files use create_draft, which returns an upload URL");
    expect(send.description).toContain("Send files as they are; fmsg compresses them in transit.");
    expect(JSON.stringify(send.inputSchema)).not.toContain("upload folder");
    expect(tools.find((t) => t.name === "create_draft")!.description).toContain("upload them with your host's authenticated HTTP tools");
  });

  it("passes upstream refusals through, such as a sent message", async () => {
    const { id, url } = await draft();
    await call(client, "send_draft", { id });
    const response = await put(url("late.txt"), "too late");
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toContain("attachments cannot be added to a sent message");
  });
});
