/**
 * End-to-end against two real fmsg stacks (see .github/scripts/run-fmsg-docker-e2e.sh).
 * alice lives on one host, bob and carol on another, so every send crosses hosts.
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { FmsgClient } from "../src/client/client.js";
import { loadConfig } from "../src/config.js";
import { StaticCallerProvider } from "../src/context.js";
import { createHttpServer, type HttpServerHandle } from "../src/http.js";
import { createFmsgMcpServer } from "../src/server.js";
import { call, structured, text } from "./helpers.js";

const enabled = process.env.FMSG_E2E === "1";

function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required when FMSG_E2E=1`);
  return v;
}

async function connect(apiUrl: string, apiKey: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const config = loadConfig({ FMSG_API_URL: apiUrl, FMSG_API_KEY: apiKey }, "stdio");
  const server = createFmsgMcpServer(new StaticCallerProvider(new FmsgClient(apiUrl, apiKey)), config);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await server.connect(st);
  await client.connect(ct);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe.skipIf(!enabled)("fmsg-docker end to end", () => {
  const token = `${Date.now()}-${process.pid}`;
  let alice: Awaited<ReturnType<typeof connect>>;
  let bob: Awaited<ReturnType<typeof connect>>;
  let ALICE: string;
  let BOB: string;
  let CAROL: string;

  beforeAll(async () => {
    ALICE = env("FMSG_E2E_ALICE_ADDR");
    BOB = env("FMSG_E2E_BOB_ADDR");
    CAROL = env("FMSG_E2E_CAROL_ADDR");
    alice = await connect(env("FMSG_E2E_ALICE_API_URL"), env("FMSG_E2E_ALICE_API_KEY"));
    bob = await connect(env("FMSG_E2E_BOB_API_URL"), env("FMSG_E2E_BOB_API_KEY"));
  });
  afterAll(async () => {
    await alice?.close();
    await bob?.close();
  });

  it("identifies both parties", async () => {
    expect(structured<{ address: string }>(await call(alice.client, "whoami")).address).toBe(ALICE);
    expect(structured<{ address: string }>(await call(bob.client, "whoami")).address).toBe(BOB);
  });

  it("send cross-host, wait, reply, thread, react, delivery, add recipient, mark read", async () => {
    const waiting = call(bob.client, "wait_for_message", { timeout_seconds: 120, settle_seconds: 1 });
    await new Promise((r) => setTimeout(r, 1500));

    const sent = structured<{ id: string; to: string[] }>(
      await call(alice.client, "send_message", {
        to: [BOB],
        topic: `E2E ${token}`,
        body: `hello bob ${token}`,
        attachments: [{ filename: "note.txt", data_base64: Buffer.from(`attachment ${token}`).toString("base64"), content_type: "text/plain" }],
      }),
    );
    expect(sent.to).toEqual([BOB]);

    const got = structured<{ status: string; reply_target_id: string; messages: Array<{ from: string; body: string; attachments: Array<{ filename: string }> }> }>(await waiting);
    expect(got.status).toBe("message");
    expect(got.messages[0]!.from).toBe(ALICE);
    expect(got.messages[0]!.body).toBe(`hello bob ${token}`);
    expect(got.messages[0]!.attachments.map((a) => a.filename)).toEqual(["note.txt"]);
    const bobCopy = got.reply_target_id;

    const dl = await call(bob.client, "download_attachment", { id: bobCopy, filename: "note.txt" });
    expect(dl.isError).toBeFalsy();
    expect(dl.content.some((c) => c.type === "resource")).toBe(true);

    const aliceWaiting = call(alice.client, "wait_for_message", { timeout_seconds: 120, settle_seconds: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    const reply = structured<{ id: string; to: string[]; parent_id: string }>(await call(bob.client, "reply", { id: bobCopy, body: `hi alice ${token}` }));
    expect(reply.to).toEqual([ALICE]);
    const back = structured<{ messages: Array<{ body: string }>; reply_target_id: string }>(await aliceWaiting);
    expect(back.messages[0]!.body).toBe(`hi alice ${token}`);

    const thread = structured<{ messages: Array<{ body: string | null }>; participants: string[]; complete: boolean }>(await call(alice.client, "get_thread", { id: back.reply_target_id }));
    expect(thread.messages.map((m) => m.body)).toEqual([`hello bob ${token}`, `hi alice ${token}`]);
    expect(thread.participants).toEqual([BOB]);
    expect(text(await call(alice.client, "get_thread", { id: back.reply_target_id }))).toContain("not instructions");

    expect(structured<{ cleared: boolean }>(await call(alice.client, "react", { id: back.reply_target_id, emoji: "👍" })).cleared).toBe(false);

    const delivery = structured<{ recipients: Array<{ addr: string; status: string }> }>(await call(alice.client, "delivery_status", { id: sent.id }));
    expect(delivery.recipients[0]).toMatchObject({ addr: BOB, status: "delivered" });

    expect(structured<{ added: number }>(await call(alice.client, "add_recipients", { id: sent.id, add_to: [CAROL] })).added).toBe(1);
    expect(structured<{ marked: unknown[] }>(await call(alice.client, "mark_read", { ids: [back.reply_target_id] })).marked).toHaveLength(1);
  });

  it("serves HTTP mode with the caller's own key as bearer", async () => {
    const config = loadConfig({ FMSG_API_URL: env("FMSG_E2E_ALICE_API_URL") }, "http");
    const http: HttpServerHandle = createHttpServer(config, () => undefined);
    await new Promise<void>((r) => http.server.listen(0, "127.0.0.1", r));
    const port = (http.server.address() as AddressInfo).port;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${env("FMSG_E2E_ALICE_API_KEY")}` } },
    });
    const client = new Client({ name: "e2e-http", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    try {
      expect(structured<{ address: string; transport: string }>(await call(client, "whoami"))).toMatchObject({ address: ALICE, transport: "http" });
    } finally {
      await client.close();
      await http.close();
    }
  });
});
