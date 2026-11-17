import { afterEach, describe, expect, it, vi } from "vitest";
import type { Caller } from "../src/context.js";
import { FILES_EXTENSION } from "../src/files/extension.js";
import { FilesRuntime, type RoundState, type TargetClaims, type UploadRequiredResult } from "../src/files/runtime.js";

const config = { maxInlineBytes: 1024, targetTtlSeconds: 600 };
const uploads = (requestState: string): UploadRequiredResult => ({
  resultType: "upload_required",
  uploads: [{ fileId: "f", path: "/uploads/t", method: "PUT", headers: {}, credentials: "include", expiresAt: "2026-11-09T00:00:00.000Z" }],
  requestState,
});
const post = (body: unknown) => new Request("https://x/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const call = post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });

function fakeCaller(sent: boolean) {
  const client = { getMessage: vi.fn(async () => ({ id: "9", time: sent ? 1 : null })), deleteMessage: vi.fn(async () => undefined) };
  return { caller: { client, address: "@alice@example.com" } as unknown as Caller, client };
}

describe("FilesRuntime", () => {
  afterEach(() => vi.useRealTimers());

  it("puts an upload request in place of the matching input_required JSON response only", async () => {
    const runtime = new FilesRuntime(config);
    let returned: unknown;
    const response = await runtime.serve(call, undefined, async () => {
      returned = runtime.requestUploads(uploads("S1"));
      return Response.json({ jsonrpc: "2.0", id: 1, result: { resultType: "input_required", requestState: "S1" } });
    });
    expect(returned).toEqual({ resultType: "input_required", requestState: "S1" });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: uploads("S1") });
    const other = await runtime.serve(call, undefined, async () => {
      runtime.requestUploads(uploads("S1"));
      return Response.json({ jsonrpc: "2.0", id: 2, result: { resultType: "input_required", requestState: "S2" } });
    });
    expect((await other.json()).result).toEqual({ resultType: "input_required", requestState: "S2" });
  });

  it("answers a protocol error in place of the result, with 400 for -32021", async () => {
    const runtime = new FilesRuntime(config);
    const respond = (make: () => { requestState?: string } | undefined) => runtime.serve(call, undefined, async () => {
      const marker = make()!.requestState;
      return Response.json({ jsonrpc: "2.0", id: 1, result: { resultType: "input_required", requestState: marker } });
    });
    const missing = await respond(() => runtime.missingUpload());
    expect(missing.status).toBe(400);
    const body = await missing.json();
    expect(body.result).toBeUndefined();
    expect(body.error).toMatchObject({ code: -32021, data: { requiredCapabilities: { extensions: { [FILES_EXTENSION]: { upload: {} } } } } });
    const invalid = await respond(() => runtime.invalidRequestState("already used"));
    expect(invalid.status).toBe(200);
    expect((await invalid.json()).error).toMatchObject({ code: -32602, message: "Invalid or expired requestState: already used" });
  });

  it("rewrites the matching SSE event and passes the others through", async () => {
    const runtime = new FilesRuntime(config);
    const events = [
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`,
      `event: message\nid: 7\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "input_required", requestState: "S1" } })}\n\n`,
    ];
    const response = await runtime.serve(call, undefined, async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // The handler asks while the stream is open, after the first event; split a chunk mid-event too.
        controller.enqueue(new TextEncoder().encode(events[0]!));
        runtime.requestUploads(uploads("S1"));
        const second = new TextEncoder().encode(events[1]!);
        controller.enqueue(second.slice(0, 20));
        controller.enqueue(second.slice(20));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const text = await response.text();
    const [first, second] = text.split("\n\n");
    expect(first).toBe(events[0]!.trimEnd());
    expect(second).toContain("id: 7");
    const data = JSON.parse(second!.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    expect(data.result).toEqual(uploads("S1"));
  });

  it("cannot replace results outside serve()", () => {
    const runtime = new FilesRuntime(config);
    expect(runtime.requestUploads(uploads("S"))).toBeUndefined();
    expect(runtime.missingUpload()).toBeUndefined();
  });

  it("lists FileInputs on tools/list only when the request declared the extension", async () => {
    const runtime = new FilesRuntime(config);
    const listed = (body: unknown, parsed = false) => runtime.serve(post(body), parsed ? body : undefined, async () => Response.json({ listed: runtime.listsFileInputs() }));
    const meta = (settings: unknown) => ({ "io.modelcontextprotocol/clientCapabilities": { extensions: { [FILES_EXTENSION]: settings } } });
    const list = (params: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/list", params });
    expect(await (await listed(list({}))).json()).toEqual({ listed: false });
    expect(await (await listed(list({ _meta: meta({}) }))).json()).toEqual({ listed: true });
    expect(await (await listed(list({ _meta: meta({ upload: {} }) }), true)).json()).toEqual({ listed: true });
    // A revision this server does not know is not a declaration.
    expect(await (await listed(list({ _meta: meta({ revision: "2027-01" }) }))).json()).toEqual({ listed: false });
    // tools/call always accepts FileInputs, since inline ones need no declaration.
    expect(await (await listed({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).json()).toEqual({ listed: true });
    expect(runtime.listsFileInputs()).toBe(true);
  });

  it("deletes an abandoned call's unsent draft after its requestState expires, but never a sent message", async () => {
    vi.useFakeTimers();
    const runtime = new FilesRuntime(config);
    const draft = fakeCaller(false);
    runtime.newRound(draft.caller, "9");
    const sent = fakeCaller(true);
    runtime.newRound(sent.caller, "9");
    const finished = fakeCaller(false);
    const { round } = runtime.newRound(finished.caller, "9");
    runtime.mark(round, "done", "message 9 was sent");
    // Not when the targets stop taking new uploads: a transfer may still be running, and its retry may follow.
    await vi.advanceTimersByTimeAsync(661_000);
    expect(draft.client.deleteMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(draft.client.deleteMessage).toHaveBeenCalledWith("9");
    expect(sent.client.deleteMessage).not.toHaveBeenCalled();
    expect(finished.client.getMessage).not.toHaveBeenCalled();
    runtime.close();
  });

  it("leaves drafts alone with a shared key, since another instance may have completed the call", async () => {
    vi.useFakeTimers();
    const runtime = new FilesRuntime({ ...config, stateSecret: "x".repeat(32) });
    const draft = fakeCaller(false);
    runtime.newRound(draft.caller, "9");
    await vi.advanceTimersByTimeAsync(2_000_000);
    expect(draft.client.getMessage).not.toHaveBeenCalled();
    runtime.close();
  });

  it("signs target paths so only this key verifies them, and reports expiry", () => {
    const runtime = new FilesRuntime(config);
    const claims: TargetClaims = { v: 2, a: "@alice@example.com", d: "9", f: "f", n: "f.txt", s: 3, t: "text/plain", r: "r", e: Math.floor(Date.now() / 1000) + 60 };
    const path = runtime.targetPath(claims);
    expect(path).toMatch(/^\/uploads\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    const token = path.slice("/uploads/".length);
    expect(runtime.verifyTarget(token)).toEqual({ claims });
    expect(runtime.verifyTarget(token, (claims.e + 1) * 1000)).toMatchObject({ problem: "expired" });
    expect(new FilesRuntime(config).verifyTarget(token)).toEqual({ problem: "unknown" });
    const shared = (secret: string) => new FilesRuntime({ ...config, stateSecret: secret });
    const fromOne = shared("s".repeat(32)).targetPath(claims);
    expect(shared("s".repeat(32)).verifyTarget(fromOne.slice("/uploads/".length))).toEqual({ claims });
  });

  it("builds one PUT path target per pending file, with the credential and an expiry", () => {
    const runtime = new FilesRuntime(config);
    const state: RoundState = {
      v: 2, tool: "send_message", args: "a", address: "@alice@example.com", draft: "9", round: "r", exp: 1_800_000_000,
      files: [{ id: "f", filename: "f.pdf", size: 3, mimeType: "application/pdf" }], summary: {},
    };
    const request = runtime.uploadRequest(state, "S");
    expect(request).toMatchObject({
      resultType: "upload_required",
      requestState: "S",
      uploads: [{ fileId: "f", method: "PUT", headers: { "Content-Type": "application/pdf" }, credentials: "include", expiresAt: "2027-01-15T08:00:00.000Z" }],
    });
    expect(request.uploads[0]!.path.startsWith("/uploads/")).toBe(true);
    expect(request.uploads[0]).not.toHaveProperty("url");
  });
});
