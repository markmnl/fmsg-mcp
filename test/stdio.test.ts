import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, call, structured } from "./helpers.js";

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

  it("lists tools and answers whoami over a real child process", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(14);
    expect(structured<{ address: string }>(await call(client, "whoami")).address).toBe(ALICE);
    fake.seed({ from: BOB, to: [ALICE], topic: "stdio", data: "over stdio" });
    expect(structured<{ count: number }>(await call(client, "list_messages")).count).toBe(1);
  });
});
