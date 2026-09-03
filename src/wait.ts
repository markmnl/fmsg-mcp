import type WebSocket from "ws";
import { FmsgClient } from "./client/client.js";
import { compareMessageIds, maxMessageId } from "./client/message-id.js";
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

export type WaitResult = {
  status: "message" | "timeout";
  after_id: string;
  thread_root_id: string | null;
  messages: FmsgMessage[];
  pending_other_threads: Pending[];
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

  const rootCache = new Map<string, string | null>();
  const rootOf = async (id: string): Promise<string | null> => {
    if (rootCache.has(id)) return rootCache.get(id)!;
    let root: string | null = null;
    try {
      root = (await client.getThreadMessages(id, signal)).root_id;
    } catch {
      // Fall back to a bounded pid walk.
      try {
        let cur = id;
        for (let i = 0; i < 100; i++) {
          const m = await client.getMessage(cur, signal);
          if (!m.pid) {
            root = m.id;
            break;
          }
          cur = m.pid;
        }
      } catch {
        root = null;
      }
    }
    rootCache.set(id, root);
    return root;
  };
  const targetRoot = options.threadOf ? await rootOf(options.threadOf) : undefined;
  if (options.threadOf && targetRoot === null) throw new Error(`could not determine the thread of message ${options.threadOf}`);

  const seen = new Set<string>();
  const batch: FmsgMessage[] = [];
  const pending: Pending[] = [];
  let batchRoot: string | null = null;
  let transport: WaitResult["transport"] = "websocket";
  let note: string | null = null;
  let socket: WebSocket | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  let finished = false;

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
      const ids = batch.map((m) => m.id);
      resolve({
        status: batch.length ? "message" : "timeout",
        after_id: batch.length ? maxMessageId(ids)! : skippedMax,
        thread_root_id: batchRoot,
        messages: [...batch].sort((a, b) => compareMessageIds(a.id, b.id)),
        pending_other_threads: pending,
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
      const disqualified =
        m.from.toLowerCase() === me ||
        (m.reaction !== null && m.reaction !== undefined) ||
        m.no_reply === true ||
        (wantFrom !== undefined && m.from.toLowerCase() !== wantFrom);
      if (disqualified) {
        if (compareMessageIds(m.id, skippedMax) > 0) skippedMax = m.id;
        return;
      }
      const root = await rootOf(m.id);
      if (finished) return;
      if (targetRoot !== undefined && root !== targetRoot) {
        if (compareMessageIds(m.id, skippedMax) > 0) skippedMax = m.id;
        return;
      }
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
