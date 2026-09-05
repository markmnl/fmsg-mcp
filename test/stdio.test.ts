import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
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
});
