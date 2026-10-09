import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { StaticCallerProvider } from "../src/context.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE, BOB, CAROL, type Harness, call, configFor, connectHttpShaped, connectInMemory, structured } from "./helpers.js";

type Schema = Record<string, unknown>;

/**
 * Output paths ("tool.field.nested[]") allowed to publish enum or const, each with its reason. A closed value
 * set makes every new value fail for hosts that cached the schema, so keep this empty unless a value can never grow.
 */
const CLOSED_VALUES_ALLOWED: Record<string, string> = {};

/** Tools whose 0.2.5 output schema still validates current results without relaxing additionalProperties. */
const UNCHANGED_SINCE_0_2_5 = ["mark_read", "react", "resolve_address", "whoami"];

const validator = new AjvJsonSchemaValidator();

function closedSchemaProblems(schema: unknown, at: string, problems: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) closedSchemaProblems(item, at, problems);
    return problems;
  }
  if (!schema || typeof schema !== "object") return problems;
  const s = schema as Schema;
  if (s.additionalProperties === false || s.unevaluatedProperties === false) problems.push(`${at}: closed object`);
  if (("enum" in s || "const" in s) && !CLOSED_VALUES_ALLOWED[at]) problems.push(`${at}: closed value set`);
  for (const [key, value] of Object.entries(s)) {
    if (key === "properties" && value && typeof value === "object") {
      for (const [name, property] of Object.entries(value)) closedSchemaProblems(property, `${at}.${name}`, problems);
    } else if (key === "items" || key === "prefixItems") {
      closedSchemaProblems(value, `${at}[]`, problems);
    } else if (value && typeof value === "object") {
      closedSchemaProblems(value, at, problems);
    }
  }
  return problems;
}

/** What a host holding the 0.2.5 schema would accept if it ignored unknown properties. */
function withoutClosedObjects(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutClosedObjects);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k, v]) => !(k === "additionalProperties" && v === false))
    .map(([k, v]) => [k, withoutClosedObjects(v)]));
}

function validate(schema: unknown, result: CallToolResult): string | undefined {
  const check = validator.getValidator(schema as Schema)(result.structuredContent);
  return check.valid ? undefined : check.errorMessage;
}

async function outputSchemas(client: Client): Promise<Map<string, Schema>> {
  const { tools } = await client.listTools();
  return new Map(tools.map((t) => [t.name, t.outputSchema as Schema]));
}

describe("published output schemas", () => {
  let fake: FakeFmsgServer;
  let directory: string;
  let local: Harness;
  let remote: Harness;
  beforeEach(async () => {
    fake = new FakeFmsgServer();
    await fake.start();
    directory = await mkdtemp(path.join(os.tmpdir(), "fmsg-schema-"));
    local = await connectInMemory(fake, "fmsgk_alice_secret", { FMSG_DEFAULT_DOMAIN: "example.net", FMSG_MCP_DOWNLOAD_DIR: directory });
    const config = configFor(fake, "http", { FMSG_MCP_PUBLIC_URL: "https://mcp.example.com/mcp" });
    remote = await connectHttpShaped(fake, new StaticCallerProvider(local.fmsg), undefined, config);
  });
  afterEach(async () => {
    await local.close();
    await remote.close();
    await fake.stop();
    await rm(directory, { recursive: true, force: true });
  });

  async function allSchemas(): Promise<Map<string, Schema>> {
    return new Map([...await outputSchemas(remote.client), ...await outputSchemas(local.client)]);
  }

  it("are open at every depth and publish no closed value sets", async () => {
    const schemas = await allSchemas();
    expect(schemas.size).toBeGreaterThanOrEqual(16);
    const problems: string[] = [];
    for (const [name, schema] of schemas) {
      expect(schema, name).toBeTruthy();
      closedSchemaProblems(schema, name, problems);
    }
    expect(problems).toEqual([]);
  });

  it("keep the fields required by 0.2.5 and require nothing new", async () => {
    const baseline = JSON.parse(await readFile(new URL("./fixtures/output-schemas-0.2.5.json", import.meta.url), "utf8")) as Record<string, Schema>;
    const required = (schema: unknown, at: string, out: Map<string, string[]> = new Map()): Map<string, string[]> => {
      if (!schema || typeof schema !== "object") return out;
      const s = schema as Schema;
      if (Array.isArray(s.required)) out.set(at, [...(s.required as string[])].sort());
      for (const [name, property] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) required(property, `${at}.${name}`, out);
      if (s.items) required(s.items, `${at}[]`, out);
      return out;
    };
    for (const [name, schema] of await allSchemas()) {
      const before = baseline[name];
      if (!before) continue;
      expect(Object.fromEntries(required(schema, name)), name).toEqual(Object.fromEntries(required(before, name)));
    }
  });

  it("validate representative results, including against 0.2.5 schemas", async () => {
    const results: Array<[string, CallToolResult]> = [];
    const run = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
      const result = await call(client, name, args);
      structured(result);
      results.push([name, result]);
      return result;
    };

    const root = fake.seed({ from: BOB, to: [ALICE, CAROL], topic: "plans", data: "root",
      attachments: [{ filename: "p.png", data: Buffer.from([0x89, 0x50]), type: "image/png" }, { filename: "n.txt", data: Buffer.from("hi"), type: "text/plain" }] });
    const reply = fake.seed({ from: CAROL, to: [ALICE, BOB], pid: root.id, data: "reply" });
    fake.seed({ from: BOB, to: [ALICE], pid: reply.id, data: "👍", reaction: "👍", terminal: true, no_reply: true });
    const own = fake.seed({ from: ALICE, to: [BOB], topic: "mine", data: "sent by me" });

    await run(local.client, "whoami");
    await run(remote.client, "whoami");
    await run(local.client, "resolve_address", { name: "bob" });
    await run(local.client, "list_messages", { include_reactions: true });
    await run(local.client, "get_message", { id: root.id });
    await run(local.client, "get_thread", { id: reply.id });
    await run(local.client, "delivery_status", { id: own.id });
    await run(local.client, "mark_read", { ids: [root.id] });
    await run(local.client, "download_attachment", { id: root.id, filename: "n.txt" });
    await run(local.client, "download_attachment", { id: root.id, filename: "p.png" });
    await run(local.client, "save_attachment", { id: root.id, filename: "p.png" });
    await run(remote.client, "get_attachment_download_url", { id: root.id, filename: "p.png" });
    await run(local.client, "add_recipients", { id: own.id, recipients: [CAROL] });
    await run(local.client, "react", { id: root.id, emoji: "🎉" });
    await run(local.client, "react", { id: root.id, emoji: null });
    await run(local.client, "send_message", { to: ["bob"], topic: "new", body: "hello",
      attachments: [{ filename: "a.txt", data_base64: Buffer.from("x").toString("base64") }] });
    await run(local.client, "reply", { id: reply.id, body: "thanks" });
    await run(local.client, "list_sent", { include_reactions: true });
    await run(local.client, "wait_for_message", { after_id: "0", timeout_seconds: 1, settle_seconds: 0 });
    const newest = (await local.fmsg.listInbox(1, 0))[0]!.id;
    await run(local.client, "wait_for_message", { after_id: newest, timeout_seconds: 1 });

    const schemas = await allSchemas();
    expect(new Set(results.map(([name]) => name))).toEqual(new Set(schemas.keys()));
    const baseline = JSON.parse(await readFile(new URL("./fixtures/output-schemas-0.2.5.json", import.meta.url), "utf8")) as Record<string, Schema>;
    for (const [name, result] of results) {
      expect(validate(schemas.get(name), result), name).toBeUndefined();
      expect(validate(withoutClosedObjects(baseline[name]), result), `${name} (0.2.5 ignoring unknown properties)`).toBeUndefined();
      if (UNCHANGED_SINCE_0_2_5.includes(name)) expect(validate(baseline[name], result), `${name} (0.2.5 as published)`).toBeUndefined();
    }
  });

  it("flags closed objects and enums", () => {
    expect(closedSchemaProblems({ type: "object", additionalProperties: false, properties: {
      list: { type: "array", items: { type: "object", additionalProperties: false, properties: { kind: { enum: ["a"] } } } },
    } }, "tool")).toEqual(["tool: closed object", "tool.list[]: closed object", "tool.list[].kind: closed value set"]);
  });
});
