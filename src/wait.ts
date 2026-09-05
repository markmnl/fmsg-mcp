import type WebSocket from "ws";
import { FmsgClient } from "./client/client.js";
import { compareMessageIds, maxMessageId, minMessageId } from "./client/message-id.js";
import type { FmsgMessage } from "./client/types.js";
import { openFmsgWebSocket, parseWsEvent } from "./client/ws.js";

export type WaitOptions = {
  /** Only messages with an id greater than this qualify. Default: the newest inbox id at call time. */
  afterId?: string;
  /** Only messages whose thread root equals this message's root qualify. */
  threadOf?: string;
  /** Only messages from this address qualify. */
  from?: string;
  timeoutMs: number;
  settleMs: number;
  maxBatch?: number;
  pollIntervalMs?: number;
  /** How long to wait for the WebSocket to open before falling back to polling. */
  wsOpenTimeoutMs?: number;
  onTick?: (elapsedMs: number) => void;
};

export type Pending = { id: string; from: string; root_id: string | null };
export type SkipReason = "own" | "reaction" | "no_reply" | "from_mismatch" | "other_thread";
export type Skipped = { id: string; reason: SkipReason };
export type Unclassified = { id: string; from: string; error: string };

export type WaitResult = {
  status: "message" | "timeout";
  after_id: string;
  thread_root_id: string | null;
  messages: FmsgMessage[];
  pending_other_threads: Pending[];
  /** Messages deliberately passed over (the cursor advances past these). */
  skipped: Skipped[];
  /** Messages whose thread could not be determined; the cursor never advances past these. */
  unclassified: Unclassified[];
  transport: "websocket" | "poll";
  note: string | null;
};

type Deps = { openSocket?: (client: FmsgClient) => Promise<WebSocket> };

/**
 * Block until the next qualifying inbound message (plus any that arrive on the
 * same thread within the settle window), or until the deadline.
 */
export async function waitForMessage(
  client: FmsgClient,
  self: string,
  options: WaitOptions,
  signal?: AbortSignal,
  deps: Deps = {},
): Promise<WaitResult> {
  const start = Date.now();
  const deadline = start + options.timeoutMs;
  const maxBatch = options.maxBatch ?? 20;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const me = self.toLowerCase();
  const wantFrom = options.from?.toLowerCase();

  // Floor: the newest inbox id at call time unless the caller supplied a cursor.
  let floor = options.afterId;
  if (floor === undefined) {
    const [newest] = await client.listInbox(1, 0, signal);
    floor = newest?.id ?? "0";
  }
  let skippedMax = floor;

  let finished = false;
  const rootCache = new Map<string, string>();
  const lookupRoot = async (id: string): Promise<string> => {
    try {
      return (await client.getThreadMessages(id, signal)).root_id;
    } catch (error) {
      // Fall back to a bounded pid walk; any failure here propagates as "unknown".
      let cur = id;
      for (let i = 0; i < 100; i++) {
        const m = await client.getMessage(cur, signal);
        if (!m.pid) return m.id;
        cur = m.pid;
      }
      throw error;
    }
  };
  /**
   * Resolve a message's thread root. A lookup can fail transiently (the host's
   * WebSocket announces a message slightly before it is readable), so retry a
   * few times; if it still fails, throw rather than guess: a message whose
   * thread is unknown must never be mistaken for one on another thread.
   */
  const rootOf = async (id: string, attempts = 3): Promise<string> => {
    const cached = rootCache.get(id);
    if (cached !== undefined) return cached;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted || finished) break;
      try {
        const root = await lookupRoot(id);
        rootCache.set(id, root);
        return root;
      } catch (error) {
        lastError = error;
        if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
  let targetRoot: string | undefined;
  if (options.threadOf) {
    try {
      targetRoot = await rootOf(options.threadOf, 1);
    } catch {
      throw new Error(`could not determine the thread of message ${options.threadOf}`);
    }
  }

  const seen = new Set<string>();
  const batch: FmsgMessage[] = [];
  const pending: Pending[] = [];
  const skipped: Skipped[] = [];
  const unclassified: Unclassified[] = [];
  /** Messages whose thread lookup is still running; if the call ends first they count as unclassified. */
  const inflight = new Map<string, string>();
  let batchRoot: string | null = null;
  let transport: WaitResult["transport"] = "websocket";
  let note: string | null = null;
  let socket: WebSocket | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;

  return new Promise<WaitResult>((resolve, reject) => {
    const cleanup = () => {
      finished = true;
      clearTimeout(deadlineTimer);
      clearTimeout(settleTimer);
      clearInterval(pollTimer);
      clearInterval(tickTimer);
      signal?.removeEventListener("abort", onAbort);
      if (socket) {
        socket.removeAllListeners();
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    };
    const finish = () => {
      if (finished) return;
      cleanup();
      for (const [id, from] of inflight) unclassified.push({ id, from, error: "thread lookup did not complete before the call returned" });
      inflight.clear();
      const ids = batch.map((m) => m.id);
      // The cursor advances only over messages returned or deliberately skipped,
      // and never past a message whose thread could not be determined.
      let afterId = maxMessageId([...ids, skippedMax, floor])!;
      const firstUnknown = unclassified.length ? minMessageId(unclassified.map((u) => u.id))! : undefined;
      if (firstUnknown !== undefined && compareMessageIds(afterId, firstUnknown) >= 0) {
        const before = (BigInt(firstUnknown) - 1n).toString();
        afterId = compareMessageIds(before, floor) > 0 ? before : floor;
        const held = `cursor held at ${afterId}: could not determine the thread of ${unclassified.map((u) => u.id).join(", ")}; call again to retry`;
        note = note ? `${note}; ${held}` : held;
      }
      resolve({
        status: batch.length ? "message" : "timeout",
        after_id: afterId,
        thread_root_id: batchRoot,
        messages: [...batch].sort((a, b) => compareMessageIds(a.id, b.id)),
        pending_other_threads: pending,
        skipped: [...skipped].sort((a, b) => compareMessageIds(a.id, b.id)),
        unclassified: [...unclassified].sort((a, b) => compareMessageIds(a.id, b.id)),
        transport,
        note,
      });
    };
    const fail = (error: unknown) => {
      if (finished) return;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      note = "cancelled";
      finish();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();

    const deadlineTimer = setTimeout(() => {
      if (batch.length && settleTimer) note = "the time limit cut the settle window short";
      finish();
    }, Math.max(0, deadline - Date.now()));
    const tickTimer = setInterval(() => options.onTick?.(Date.now() - start), 20_000);

    const consider = async (m: FmsgMessage) => {
      if (finished || seen.has(m.id)) return;
      seen.add(m.id);
      if (compareMessageIds(m.id, floor) <= 0) return;
      const skip = (reason: SkipReason) => {
        skipped.push({ id: m.id, reason });
        if (compareMessageIds(m.id, skippedMax) > 0) skippedMax = m.id;
      };
      if (m.from.toLowerCase() === me) return skip("own");
      if (m.reaction !== null && m.reaction !== undefined) return skip("reaction");
      if (m.no_reply === true) return skip("no_reply");
      if (wantFrom !== undefined && m.from.toLowerCase() !== wantFrom) return skip("from_mismatch");
      let root: string;
      inflight.set(m.id, m.from);
      try {
        root = await rootOf(m.id);
      } catch (error) {
        if (!finished) unclassified.push({ id: m.id, from: m.from, error: error instanceof Error ? error.message : String(error) });
        return;
      } finally {
        inflight.delete(m.id);
      }
      if (finished) return;
      if (targetRoot !== undefined && root !== targetRoot) return skip("other_thread");
      if (batch.length === 0) {
        batchRoot = root;
        batch.push(m);
        const settle = Math.min(options.settleMs, Math.max(0, deadline - Date.now()));
        settleTimer = setTimeout(finish, settle);
        if (settle === 0) finish();
        return;
      }
      if (root === batchRoot && batch.length < maxBatch) {
        batch.push(m);
        return;
      }
      pending.push({ id: m.id, from: m.from, root_id: root });
    };

    const catchUp = async () => {
      try {
        const page = await client.listInbox(100, 0, signal);
        for (const m of [...page].reverse()) await consider(m);
      } catch (error) {
        if (!finished) fail(error);
      }
    };

    const startPolling = (why: string) => {
      if (finished || pollTimer) return;
      transport = "poll";
      note = note ?? why;
      pollTimer = setInterval(() => void catchUp(), pollIntervalMs);
      void catchUp();
    };

    const open = deps.openSocket ?? openFmsgWebSocket;
    open(client)
      .then((ws) => {
        if (finished) {
          ws.close();
          return;
        }
        socket = ws;
        const openTimer = setTimeout(() => {
          if (ws.readyState !== ws.OPEN) {
            ws.removeAllListeners();
            ws.terminate();
            socket = undefined;
            startPolling("WebSocket did not open; polling instead");
          }
        }, options.wsOpenTimeoutMs ?? 10_000);
        ws.on("open", () => {
          clearTimeout(openTimer);
          void catchUp();
        });
        ws.on("message", (raw) => {
          const event = parseWsEvent(raw);
          if (event?.type === "new_msg" && event.data) void consider(event.data);
        });
        ws.on("error", () => {
          clearTimeout(openTimer);
          socket = undefined;
          startPolling("WebSocket failed; polling instead");
        });
        ws.on("close", () => {
          clearTimeout(openTimer);
          socket = undefined;
          if (!finished) startPolling("WebSocket closed; polling instead");
        });
      })
      .catch(() => startPolling("WebSocket unavailable; polling instead"));
  });
}
