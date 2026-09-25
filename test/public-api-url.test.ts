import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FmsgClient } from "../src/client/client.js";
import { loadConfig } from "../src/config.js";
import { StaticCallerProvider } from "../src/context.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, call, configFor, connectHttpShaped, connectInMemory, structured, text } from "./helpers.js";

const KEY = { FMSG_API_KEY: "fmsgk_alice_secret" };

describe("FMSG_API_PUBLIC_URL config", () => {
  it("defaults to FMSG_API_URL over stdio, including loopback and private cleartext URLs", () => {
    expect(loadConfig({ FMSG_API_URL: "https://api.example.com/", ...KEY }, "stdio").apiPublicUrl).toBe("https://api.example.com");
    expect(loadConfig({ FMSG_API_URL: "http://localhost:8000", ...KEY }, "stdio").apiPublicUrl).toBe("http://localhost:8000");
    expect(
      loadConfig({ FMSG_API_URL: "http://10.0.0.5:8000", FMSG_ALLOW_INSECURE_HTTP: "1", ...KEY }, "stdio").apiPublicUrl,
    ).toBe("http://10.0.0.5:8000");
  });

  it("defaults to FMSG_API_URL over HTTP only when it is HTTPS", () => {
    expect(loadConfig({ FMSG_API_URL: "https://api.example.com" }, "http").apiPublicUrl).toBe("https://api.example.com");
    expect(loadConfig({ FMSG_API_URL: "http://127.0.0.1:8000" }, "http").apiPublicUrl).toBeUndefined();
    expect(loadConfig({ FMSG_API_URL: "http://10.0.0.5:8000", FMSG_ALLOW_INSECURE_HTTP: "1" }, "http").apiPublicUrl).toBeUndefined();
  });

  it("uses an explicit public URL in either transport without changing the request URL", () => {
    const http = loadConfig(
      { FMSG_API_URL: "http://10.0.0.5:8000", FMSG_ALLOW_INSECURE_HTTP: "1", FMSG_API_PUBLIC_URL: "https://api.example.com/" },
      "http",
    );
    expect(http.apiUrl).toBe("http://10.0.0.5:8000");
    expect(http.apiPublicUrl).toBe("https://api.example.com");
    expect(
      loadConfig({ FMSG_API_URL: "http://localhost:8000", FMSG_API_PUBLIC_URL: "https://api.example.com", ...KEY }, "stdio").apiPublicUrl,
    ).toBe("https://api.example.com");
  });

  it("validates the public URL like FMSG_API_URL", () => {
    const base = { FMSG_API_URL: "https://api.example.com" };
    for (const bad of ["not a url", "ftp://api.example.com", "https://user:pw@api.example.com", "https://api.example.com/?k=1"]) {
      expect(() => loadConfig({ ...base, FMSG_API_PUBLIC_URL: bad }, "http")).toThrow("FMSG_API_PUBLIC_URL");
    }
    expect(() => loadConfig({ ...base, FMSG_API_PUBLIC_URL: "http://api.example.com" }, "http")).toThrow("FMSG_API_PUBLIC_URL must use HTTPS");
    expect(loadConfig({ ...base, FMSG_API_PUBLIC_URL: "http://localhost:8000" }, "http").apiPublicUrl).toBe("http://localhost:8000");
    expect(
      loadConfig({ ...base, FMSG_API_PUBLIC_URL: "http://api.internal:8000", FMSG_ALLOW_INSECURE_HTTP: "1" }, "http").apiPublicUrl,
    ).toBe("http://api.internal:8000");
  });
});

describe("whoami api_url", () => {
  let fake: FakeFmsgServer;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("shows the configured Web API URL over stdio", async () => {
    const h = await connectInMemory(fake);
    try {
      const result = await call(h.client, "whoami");
      expect(structured(result)).toMatchObject({ address: ALICE, api_url: fake.baseUrl, transport: "stdio" });
      expect(text(result)).toContain(`on ${fake.baseUrl}`);
    } finally { await h.close(); }
  });

  it("hides a cleartext upstream URL over HTTP", async () => {
    const h = await connectHttpShaped(fake, new StaticCallerProvider(new FmsgClient(fake.baseUrl, "fmsgk_alice_secret")), undefined);
    try {
      const result = await call(h.client, "whoami");
      expect(structured(result)).toMatchObject({ address: ALICE, api_url: null, transport: "http" });
      expect(text(result)).not.toContain(fake.baseUrl);
      expect(text(result)).toContain(`You are **${ALICE}** (http).`);
    } finally { await h.close(); }
  });

  it("shows FMSG_API_PUBLIC_URL over HTTP while requests still use FMSG_API_URL", async () => {
    const config = configFor(fake, "http", { FMSG_API_PUBLIC_URL: "https://api.example.com" });
    const h = await connectHttpShaped(fake, new StaticCallerProvider(new FmsgClient(fake.baseUrl, "fmsgk_alice_secret")), undefined, config);
    try {
      const result = await call(h.client, "whoami");
      expect(structured(result)).toMatchObject({ address: ALICE, api_url: "https://api.example.com" });
      expect(text(result)).toContain("on https://api.example.com (http)");
      expect(text(result)).not.toContain(fake.baseUrl);
      expect(fake.requests.length).toBeGreaterThan(0);
    } finally { await h.close(); }
  });
});
