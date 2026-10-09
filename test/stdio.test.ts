import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, call, structured, text } from "./helpers.js";

const entry = path.resolve("dist/index.js");

describe.skipIf(!existsSync(entry))("stdio binary", () => {
  let fake: FakeFmsgServer;
  let client: Client;
  beforeAll(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        env: { ...process.env, FMSG_API_URL: fake.baseUrl, FMSG_API_KEY: "fmsgk_alice_secret" } as Record<string, string>,
        stderr: "pipe",
      }),
    );
  });
  afterAll(async () => {
    await client.close();
    await fake.stop();
  });

  it("starts without credentials, lists tools and explains what is missing", async () => {
    const bare = new Client({ name: "stdio-bare", version: "0.0.0" });
    const env = { ...process.env } as Record<string, string>;
    delete env.FMSG_API_URL;
    delete env.FMSG_API_KEY;
    await bare.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" }));
    try {
      expect((await bare.listTools()).tools.length).toBe(14);
      const r = await call(bare, "whoami");
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("FMSG_API_URL and FMSG_API_KEY");
    } finally {
      await bare.close();
    }
  });

  it("lists tools and answers whoami over a real child process", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(14);
    expect(client.getInstructions()).toContain(`you are acting as ${ALICE}`);
    expect(structured<{ address: string }>(await call(client, "whoami")).address).toBe(ALICE);
    fake.seed({ from: BOB, to: [ALICE], topic: "stdio", data: "over stdio" });
    expect(structured<{ count: number }>(await call(client, "list_messages")).count).toBe(1);
  });

  it.each([
    [{ FMSG_API_URL: "http://host.docker.internal:8000", FMSG_API_KEY: "fmsgk_example_key" }, "FMSG_ALLOW_INSECURE_HTTP=1"],
    [{ FMSG_API_URL: "https://api.example.com", FMSG_API_KEY: "invalid" }, "FMSG_API_KEY must start"],
    [{ FMSG_API_URL: "https://api.example.com", FMSG_API_KEY: "fmsgk_example_key", FMSG_MCP_WAIT_MAX_SECONDS: "bad" }, "FMSG_MCP_WAIT_MAX_SECONDS"],
  ])("keeps configuration errors visible through MCP discovery", async (settings, hint) => {
    const unconfigured = new Client({ name: "invalid-config", version: "0.0.0" });
    const env = { ...process.env, ...settings, FMSG_ALLOW_INSECURE_HTTP: "0" } as Record<string, string>;
    await unconfigured.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" }));
    try {
      expect((await unconfigured.listTools()).tools.length).toBe(14);
      const result = await call(unconfigured, "whoami");
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(hint);
      expect(text(result)).toContain("restart");
      expect(text(result)).not.toContain("not instructions");
    } finally { await unconfigured.close(); }
  });

  it("exits promptly on SIGTERM over HTTP, ending an in-flight wait with an interrupted result", async () => {
    const child = spawn(process.execPath, [entry, "--http", "127.0.0.1:0"], {
      env: { ...process.env, FMSG_API_URL: fake.baseUrl } as Record<string, string>,
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      let log = "";
      child.stderr!.on("data", (chunk) => { log += String(chunk); });
      await vi.waitFor(() => expect(log).toMatch(/serving Streamable HTTP at (http:\/\/\S+\/mcp)/u), { timeout: 5000 });
      const url = /serving Streamable HTTP at (http:\/\/\S+\/mcp)/u.exec(log)![1]!;
      const remote = new Client({ name: "sigterm-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
      await remote.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: "Bearer fmsgk_alice_secret" } } }));
      const seen = fake.seed({ from: BOB, to: [ALICE], data: "already seen" });
      const waiting = call(remote, "wait_for_message", { after_id: seen.id, timeout_seconds: 110 });
      await vi.waitFor(() => expect(fake.connectedSockets(ALICE)).toBe(1), { timeout: 5000 });
      const started = Date.now();
      child.kill("SIGTERM");
      expect(structured<{ status: string; after_id: string }>(await waiting)).toMatchObject({ status: "interrupted", after_id: seen.id });
      const [code] = await once(child, "exit");
      expect(code).toBe(0);
      expect(Date.now() - started).toBeLessThan(3000);
      await remote.close().catch(() => undefined);
    } finally { child.kill("SIGKILL"); }
  });
});
