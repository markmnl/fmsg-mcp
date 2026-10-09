import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CALLER_DOMAIN, resolveAddress } from "../src/address.js";
import { loadConfig } from "../src/config.js";
import { createHttpServer, type HttpServerHandle } from "../src/http.js";
import { buildInstructions } from "../src/instructions.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { FakeOAuthServer } from "./fake-oauth-server.js";
import { ALICE, CAROL, call, configFor, connectInMemory, structured, text } from "./helpers.js";

type Who = { address: string; default_domain: string | null };

describe("FMSG_DEFAULT_DOMAIN=caller", () => {
  it("parses the reserved value case-insensitively and leaves real domains unchanged", () => {
    const parse = (value?: string) =>
      loadConfig({ FMSG_API_URL: "https://api.example.com", ...(value === undefined ? {} : { FMSG_DEFAULT_DOMAIN: value }) }, "http").defaultDomain;
    expect(parse("caller")).toBe(CALLER_DOMAIN);
    expect(parse(" CALLER ")).toBe(CALLER_DOMAIN);
    expect(parse("@Caller")).toBe(CALLER_DOMAIN);
    expect(parse("example.org")).toBe("example.org");
    expect(parse("@example.org")).toBe("example.org");
    expect(parse("")).toBeUndefined();
    expect(parse()).toBeUndefined();
  });

  it("resolves short names on the caller's domain, after literal addresses and directory entries", () => {
    const directory = { bob: "@bob@example.com" };
    expect(resolveAddress("dave", { defaultDomain: CALLER_DOMAIN, callerAddress: "@mark@Example.ORG" }))
      .toEqual({ address: "@dave@example.org", resolution: "default_domain" });
    expect(resolveAddress("Bob", { defaultDomain: CALLER_DOMAIN, callerAddress: "@mark@example.org", directory }))
      .toEqual({ address: "@bob@example.com", resolution: "directory" });
    expect(resolveAddress("@x@example.net", { defaultDomain: CALLER_DOMAIN, callerAddress: "@mark@example.org" }).address).toBe("@x@example.net");
    expect(() => resolveAddress("dave", { defaultDomain: CALLER_DOMAIN })).toThrow(/ask for the full @user@domain address/u);
    expect(resolveAddress("dave", { defaultDomain: "example.net", callerAddress: "@mark@example.org" }).address).toBe("@dave@example.net");
    expect(() => resolveAddress("dave", { callerAddress: "@mark@example.org" })).toThrow(/ask for the full/u);
  });

  it("names the caller's domain in the instructions when known", () => {
    expect(buildInstructions({ address: CAROL, defaultDomain: CALLER_DOMAIN })).toContain("short names resolve to @name@example.org.");
    expect(buildInstructions({ defaultDomain: CALLER_DOMAIN })).toContain("short names resolve to @name@<your domain>");
    expect(buildInstructions({ address: CAROL, defaultDomain: "example.net" })).toContain("short names resolve to @name@example.net.");
    expect(buildInstructions({ address: CAROL })).not.toContain("short names");
  });

  it("resolves on the stdio caller's domain once the address is known", async () => {
    const fake = new FakeFmsgServer();
    await fake.start();
    const h = await connectInMemory(fake, "fmsgk_alice_secret", { FMSG_DEFAULT_DOMAIN: "caller" });
    try {
      expect(h.client.getInstructions()).toContain("short names resolve to @name@<your domain>");
      expect(structured(await call(h.client, "resolve_address", { name: "dave" }))).toEqual({ address: "@dave@example.com", resolution: "default_domain" });
      expect(structured<Who>(await call(h.client, "whoami")).default_domain).toBe("example.com");
    } finally {
      await h.close();
      await fake.stop();
    }
  });
});

describe("FMSG_DEFAULT_DOMAIN over HTTP", () => {
  let fake: FakeFmsgServer;
  let idp: FakeOAuthServer | undefined;
  let http: HttpServerHandle | undefined;
  const clients: Client[] = [];
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await http?.close();
    await idp?.stop();
    http = idp = undefined;
    await fake.stop();
  });

  async function serve(extra: Record<string, string>, oauth = false): Promise<string> {
    let config = configFor(fake, "http", extra);
    if (oauth) {
      idp = new FakeOAuthServer(fake);
      await idp.start();
      config = { ...config, oauth: idp.config };
    }
    http = createHttpServer(config, () => undefined);
    await new Promise<void>((resolve) => http!.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(http.server.address() as AddressInfo).port}/mcp`;
  }

  async function connect(url: string, token: string): Promise<Client> {
    const client = new Client({ name: "domain-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  }

  async function expectDomain(client: Client, address: string, domain: string | null): Promise<void> {
    const who = await call(client, "whoami");
    expect(structured<Who>(who)).toMatchObject({ address, default_domain: domain });
    const resolved = await call(client, "resolve_address", { name: "dave" });
    const sent = await call(client, "send_message", { to: ["dave"], topic: "hi", body: "hello" });
    if (domain === null) {
      expect(text(who)).not.toContain("Short names resolve");
      expect(client.getInstructions()).not.toContain("short names");
      expect(resolved.isError).toBe(true);
      expect(text(resolved)).toContain("ask for the full @user@domain address");
      expect(sent.isError).toBe(true);
      return;
    }
    expect(text(who)).toContain(`Short names resolve to @name@${domain}.`);
    expect(client.getInstructions()).toContain(`short names resolve to @name@${domain}.`);
    expect(structured(resolved)).toEqual({ address: `@dave@${domain}`, resolution: "default_domain" });
    expect(structured<{ from: string; to: string[] }>(sent)).toMatchObject({ from: address, to: [`@dave@${domain}`] });
  }

  it("gives each API-key caller their own domain", async () => {
    const url = await serve({ FMSG_DEFAULT_DOMAIN: "caller" });
    const alice = await connect(url, "fmsgk_alice_secret");
    const carol = await connect(url, "fmsgk_carol_secret");
    await expectDomain(alice, ALICE, "example.com");
    await expectDomain(carol, CAROL, "example.org");
  });

  it("gives each OAuth caller their own domain", async () => {
    const url = await serve({ FMSG_DEFAULT_DOMAIN: "caller" }, true);
    const alice = await connect(url, await idp!.token());
    const carol = await connect(url, await idp!.token({ sub: CAROL }));
    await expectDomain(alice, ALICE, "example.com");
    await expectDomain(carol, CAROL, "example.org");
  });

  it("keeps a fixed default domain for every caller", async () => {
    const url = await serve({ FMSG_DEFAULT_DOMAIN: "example.net" });
    await expectDomain(await connect(url, "fmsgk_alice_secret"), ALICE, "example.net");
    await expectDomain(await connect(url, "fmsgk_carol_secret"), CAROL, "example.net");
  });

  it("does not resolve short names without a default domain", async () => {
    const url = await serve({});
    await expectDomain(await connect(url, "fmsgk_alice_secret"), ALICE, null);
  });
});
