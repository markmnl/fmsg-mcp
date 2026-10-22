import { afterEach, describe, expect, it, vi } from "vitest";
import type { Caller } from "../src/context.js";
import { FilesRuntime, type RoundState, type TargetClaims } from "../src/files/runtime.js";

const config = { maxInlineBytes: 1024, targetTtlSeconds: 600 };
const offer = { method: "io.modelcontextprotocol/files/upload" as const, params: { files: [{ fileId: "f", url: "https://x/mcp/uploads/t", headers: {}, credentials: "include" as const }] } };

function fakeCaller(sent: boolean) {
  const client = { getMessage: vi.fn(async () => ({ id: "9", time: sent ? 1 : null })), deleteMessage: vi.fn(async () => undefined) };
  return { caller: { client, address: "@alice@example.com" } as unknown as Caller, client };
}

describe("FilesRuntime", () => {
  afterEach(() => vi.useRealTimers());

  it("adds an offered upload request to the matching input_required JSON response only", async () => {
    const runtime = new FilesRuntime(config, "https://mcp.example.com/mcp");
    const response = await runtime.serve(async () => {
      runtime.offer("S1", offer);
      return Response.json({ jsonrpc: "2.0", id: 1, result: { resultType: "input_required", requestState: "S1" } });
    });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { resultType: "input_required", requestState: "S1", inputRequests: { uploads: offer } } });
    const other = await runtime.serve(async () => {
      runtime.offer("S1", offer);
      return Response.json({ jsonrpc: "2.0", id: 2, result: { resultType: "input_required", requestState: "S2" } });
    });
    expect((await other.json()).result.inputRequests).toBeUndefined();
  });

  it("rewrites the matching SSE event and passes the others through", async () => {
    const runtime = new FilesRuntime(config, "https://mcp.example.com/mcp");
    const events = [
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`,
      `event: message\nid: 7\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "input_required", requestState: "S1" } })}\n\n`,
    ];
    const response = await runtime.serve(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // The handler offers while the stream is open, after the first event; split a chunk mid-event too.
        controller.enqueue(new TextEncoder().encode(events[0]!));
        runtime.offer("S1", offer);
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
    expect(data.result.inputRequests.uploads).toEqual(offer);
  });

  it("cannot offer outside serve()", () => {
    expect(new FilesRuntime(config, "https://mcp.example.com/mcp").offer("S", offer)).toBe(false);
  });

  it("deletes an abandoned call's unsent draft after its targets expire, but never a sent message", async () => {
    vi.useFakeTimers();
    const runtime = new FilesRuntime(config, "https://mcp.example.com/mcp");
    const draft = fakeCaller(false);
    runtime.newRound(draft.caller, "9");
    const sent = fakeCaller(true);
    runtime.newRound(sent.caller, "9");
    const finished = fakeCaller(false);
    const { round } = runtime.newRound(finished.caller, "9");
    runtime.mark(round, "done", "message 9 was sent");
    await vi.advanceTimersByTimeAsync(661_000);
    expect(draft.client.deleteMessage).toHaveBeenCalledWith("9");
    expect(sent.client.deleteMessage).not.toHaveBeenCalled();
    expect(finished.client.getMessage).not.toHaveBeenCalled();
    runtime.close();
  });

  it("leaves drafts alone with a shared key, since another instance may have completed the call", async () => {
    vi.useFakeTimers();
    const runtime = new FilesRuntime({ ...config, stateSecret: "x".repeat(32) }, "https://mcp.example.com/mcp");
    const draft = fakeCaller(false);
    runtime.newRound(draft.caller, "9");
    await vi.advanceTimersByTimeAsync(661_000);
    expect(draft.client.getMessage).not.toHaveBeenCalled();
    runtime.close();
  });

  it("signs targets so only this key verifies them, and reports expiry", () => {
    const runtime = new FilesRuntime(config, "https://mcp.example.com/mcp/");
    const claims: TargetClaims = { v: 1, a: "@alice@example.com", d: "9", f: "f", n: "f.txt", s: 3, h: "00".repeat(32), t: "text/plain", r: "r", e: Math.floor(Date.now() / 1000) + 60 };
    const url = runtime.targetUrl(claims);
    expect(url.startsWith("https://mcp.example.com/mcp/uploads/")).toBe(true);
    const token = url.slice(url.lastIndexOf("/") + 1);
    expect(runtime.verifyTarget(token)).toEqual({ claims });
    expect(runtime.verifyTarget(token, (claims.e + 1) * 1000)).toMatchObject({ problem: "expired" });
    expect(new FilesRuntime(config, "https://mcp.example.com/mcp").verifyTarget(token)).toEqual({ problem: "unknown" });
    const shared = (secret: string) => new FilesRuntime({ ...config, stateSecret: secret }, "https://mcp.example.com/mcp");
    const fromOne = shared("s".repeat(32)).targetUrl(claims);
    expect(shared("s".repeat(32)).verifyTarget(fromOne.slice(fromOne.lastIndexOf("/") + 1))).toEqual({ claims });
  });

  it("builds one include target per pending file", () => {
    const runtime = new FilesRuntime(config, "https://mcp.example.com/mcp");
    const state: RoundState = {
      v: 1, tool: "send_message", args: "a", address: "@alice@example.com", draft: "9", round: "r", exp: 1,
      files: [{ id: "f", filename: "f.pdf", size: 3, sha256: "00".repeat(32), mimeType: "application/pdf" }], summary: {},
    };
    expect(runtime.uploadRequest(state)).toMatchObject({
      method: "io.modelcontextprotocol/files/upload",
      params: { files: [{ fileId: "f", headers: { "Content-Type": "application/pdf" }, credentials: "include" }] },
    });
  });
});
