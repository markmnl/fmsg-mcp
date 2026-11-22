import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { FmsgClient } from "../src/client/client.js";
import { type CallerProvider, StaticCallerProvider, UnconfiguredCallerProvider } from "../src/context.js";
import { createHttpServer, type HttpServerHandle } from "../src/http.js";
import { SearchSupportCache, searchAvailable } from "../src/search-support.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, CAROL, type Harness, call, configFor, connectInMemory, structured, text } from "./helpers.js";

type Thread = {
  root: string; topic: string; time: string | null; message_count: number; unread: number; participants: string[];
  latest: { id: string; from: string; time: string | null } | null; match: { id: string; field: string; text: string } | null;
};
type Result = { total: number; next_offset: number | null; terms: string[]; threads: Thread[] };

describe("search_messages", () => {
  let fake: FakeFmsgServer;
  let h: Harness;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    fake.search = "implemented";
    await fake.start();
  });
  afterEach(async () => {
    await h?.close();
    await fake.stop();
  });

  it("is listed, read-only, only when the server is told search is available", async () => {
    h = await connectInMemory(fake, "fmsgk_alice_secret", {}, { search: true });
    const tool = (await h.client.listTools()).tools.find((t) => t.name === "search_messages");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(h.client.getInstructions()).toContain("search_messages");
    expect(h.client.getInstructions()).not.toContain("There is no search");
    await h.close();

    h = await connectInMemory(fake);
    expect((await h.client.listTools()).tools.map((t) => t.name)).not.toContain("search_messages");
    expect(h.client.getInstructions()).toContain("There is no search");
  });

  it("finds whole threads by their words and summarises them", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "Quarterly planning", data: "Agenda attached" });
    fake.seed({ from: ALICE, to: [BOB, CAROL], pid: root.id, data: "The budget review is on Friday" });
    const last = fake.seed({ from: CAROL, to: [ALICE, BOB], pid: root.id, data: "Thanks" });
    fake.seed({ from: BOB, to: [ALICE], pid: last.id, data: "👍", reaction: "👍", no_reply: true, terminal: true });
    fake.seed({ from: BOB, to: [ALICE], topic: "Lunch", data: "Pizza on Friday?" });
    h = await connectInMemory(fake, "fmsgk_alice_secret", {}, { search: true });

    const result = await call(h.client, "search_messages", { query: "budg REVIEW" });
    const out = structured<Result>(result);
    expect(out).toMatchObject({ total: 1, next_offset: null, terms: ["budg", "review"] });
    expect(out.threads).toHaveLength(1);
    expect(out.threads[0]).toMatchObject({
      root: root.id, topic: "Quarterly planning", message_count: 3, unread: 2,
      latest: { id: last.id, from: CAROL },
      match: { field: "body", text: "The budget review is on Friday" },
    });
    expect(out.threads[0]!.participants.sort()).toEqual([BOB, CAROL].sort());
    expect(text(result)).toContain(`**${root.id}**`);
    expect(text(result)).toContain("matched body");

    // The words must all be in one message; an empty query lists by the filters alone.
    expect(structured<Result>(await call(h.client, "search_messages", { query: "budget pizza" })).total).toBe(0);
    expect(structured<Result>(await call(h.client, "search_messages", { query: "friday" })).total).toBe(2);
    const all = structured<Result>(await call(h.client, "search_messages", {}));
    expect(all.total).toBe(2);
    expect(all.threads.every((t) => t.match === null)).toBe(true);
  });

  it("passes the filters and pages through results", async () => {
    for (let i = 0; i < 3; i++) fake.seed({ from: BOB, to: [ALICE], topic: `Report ${i}`, data: "weekly report" });
    h = await connectInMemory(fake, "fmsgk_alice_secret", {}, { search: true });

    const first = structured<Result>(await call(h.client, "search_messages", { query: "report", limit: 2 }));
    expect(first).toMatchObject({ total: 3, next_offset: 2 });
    expect(first.threads.map((t) => t.topic)).toEqual(["Report 2", "Report 1"]);
    const second = structured<Result>(await call(h.client, "search_messages", { query: "report", limit: 2, offset: 2 }));
    expect(second).toMatchObject({ total: 3, next_offset: null });
    expect(second.threads.map((t) => t.topic)).toEqual(["Report 0"]);

    await call(h.client, "search_messages", {
      query: "x", unread_only: true, with_attachments: true, drafts_only: true, in_trash: true, sort: "oldest", limit: 5, offset: 1,
    });
    expect(Object.fromEntries(fake.searches.at(-1)!)).toEqual({
      q: "x", sort: "oldest", files: "true", unread: "true", scope: "drafts", trash: "only", limit: "5", offset: "1",
    });
  });

  it("explains a host that refuses search, and remembers it", async () => {
    // 501 from a host that defines search; 400 "invalid message id" from one older than search.
    for (const mode of ["not_implemented", "missing"] as const) {
      fake.search = mode;
      const cache = new SearchSupportCache();
      h = await connectInMemory(fake, "fmsgk_alice_secret", {}, { search: true, searchSupport: cache });
      const result = await call(h.client, "search_messages", { query: "anything" });
      expect(result.isError, mode).toBe(true);
      expect(text(result), mode).toContain("doesn't support search");
      expect(cache.cached(fake.baseUrl), mode).toBe(false);
      await h.close();
    }
  });

  it("leaves trashed messages and edits out of the counts unless searching the trash", async () => {
    const root = fake.seed({ from: BOB, to: [ALICE], topic: "Offsite", data: "Venue ideas" });
    const kept = fake.seed({ from: CAROL, to: [ALICE, BOB], pid: root.id, data: "The lake house" });
    const binned = fake.seed({ from: BOB, to: [ALICE], pid: kept.id, data: "Or the city" });
    binned.trash = "message";
    fake.seed({ from: CAROL, to: [ALICE, BOB], pid: kept.id, data: "", type: "application/vnd.fmsg.edit", edit: true, no_reply: true, terminal: true });
    h = await connectInMemory(fake, "fmsgk_alice_secret", {}, { search: true });

    const out = structured<Result>(await call(h.client, "search_messages", { query: "venue" }));
    expect(out.threads[0]).toMatchObject({ root: root.id, message_count: 2, unread: 2, latest: { id: kept.id } });
    const trash = structured<Result>(await call(h.client, "search_messages", { in_trash: true }));
    expect(trash.threads[0]).toMatchObject({ root: root.id, message_count: 3, unread: 3, latest: { id: binned.id } });
  });

  it("asks for more specific words when a search takes too long", async () => {
    fake.searchTooSlow = true;
    h = await connectInMemory(fake, "fmsgk_alice_secret", {}, { search: true });
    const result = await call(h.client, "search_messages", { query: "the" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("took too long");
  });
});

describe("searchAvailable", () => {
  let fake: FakeFmsgServer;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  const provider = () => new StaticCallerProvider(new FmsgClient(fake.baseUrl, "fmsgk_alice_secret"));

  it("probes with a query that has no words and remembers the answer", async () => {
    for (const [mode, expected] of [["implemented", true], ["not_implemented", false], ["missing", false]] as const) {
      fake.search = mode;
      const cache = new SearchSupportCache();
      expect(await searchAvailable(provider(), undefined, { exchange: true, cache }), mode).toBe(expected);
      expect(cache.cached(fake.baseUrl), mode).toBe(expected);
    }
    expect(fake.searches.every((p) => p.get("q") === "-")).toBe(true);
  });

  it("asks again once the answer is out of date, without making the request wait", async () => {
    let now = 1_000;
    const cache = new SearchSupportCache(60_000, 2_000, () => now);
    fake.search = "not_implemented";
    expect(await searchAvailable(provider(), undefined, { exchange: true, cache })).toBe(false);
    fake.search = "implemented";
    expect(await searchAvailable(provider(), undefined, { exchange: true, cache })).toBe(false);
    now += 60_001;
    // The stale answer stands for this request; the next one gets the fresh answer.
    expect(await searchAvailable(provider(), undefined, { exchange: true, cache })).toBe(false);
    await cache.pendingFor(fake.baseUrl);
    expect(await searchAvailable(provider(), undefined, { exchange: true, cache })).toBe(true);
  });

  it("lists the tool when the host can't be asked, without remembering that", async () => {
    const cache = new SearchSupportCache();
    const unreachable = new StaticCallerProvider(new FmsgClient("http://127.0.0.1:9", "fmsgk_alice_secret", { allowInsecureHttp: true }));
    expect(await searchAvailable(unreachable, undefined, { exchange: true, cache })).toBe(true);
    expect(cache.lastKnown("http://127.0.0.1:9")).toBeUndefined();
  });

  it("never starts a token exchange just to list tools", async () => {
    fake.search = "not_implemented";
    // Like a signed-in (OAuth) caller before its first tool call: known, but holding no Web API token yet.
    const client = new FmsgClient(fake.baseUrl, "fmsgk_alice_secret");
    const signedIn: CallerProvider = { forRequest: async () => ({ client, address: ALICE, tokenExpiresAt: async () => 0 }) };
    const cache = new SearchSupportCache();
    expect(await searchAvailable(signedIn, undefined, { cache })).toBe(true);
    expect(fake.requests).toHaveLength(0);
    // The last answer stands once known, even when out of date.
    let now = 0;
    const stale = new SearchSupportCache(10, 2_000, () => now);
    stale.remember(fake.baseUrl, false);
    now = 100;
    expect(await searchAvailable(signedIn, undefined, { cache: stale })).toBe(false);
    expect(fake.requests).toHaveLength(0);
    // Once it holds a token, asking costs no exchange, and happens in the background.
    await client.getToken();
    expect(await searchAvailable(signedIn, undefined, { cache: stale })).toBe(false);
    await stale.pendingFor(fake.baseUrl);
    expect(fake.requests.map((r) => r.path)).toEqual(["/fmsg/token", "/fmsg/search"]);
  });

  it("gives an unconfigured server no search tool", async () => {
    expect(await searchAvailable(new UnconfiguredCallerProvider("not configured"), undefined)).toBe(false);
  });
});

describe("search_messages over HTTP", () => {
  let fake: FakeFmsgServer;
  let http: HttpServerHandle;
  let base: string;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    http = createHttpServer(configFor(fake, "http"), () => undefined);
    await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await http.close();
    await fake.stop();
  });

  async function toolNames(): Promise<string[]> {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: "Bearer fmsgk_alice_secret" } },
    });
    const client = new Client({ name: "search-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    try {
      return (await client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  }

  it("lists search_messages for a Web API that implements search", async () => {
    fake.search = "implemented";
    expect(await toolNames()).toContain("search_messages");
  });

  it("leaves it out for a Web API that answers 501", async () => {
    fake.search = "not_implemented";
    expect(await toolNames()).not.toContain("search_messages");
  });
});
