/**
 * FMSG-006 indicators shown on the caller's behalf with the indicate tool: a short-lived emoji, such as ⏳ while an
 * agent works on a reply, that the other participants of a message see until it expires or is cleared.
 *
 * An indicator set with indicate is refreshed before its ttl lapses until the caller replies in that thread, reacts to
 * the message, marks it read, clears it with an empty emoji, the time limit passes or the session ends. Nothing is
 * shown unless the caller asks: reading a message never starts one. Refreshes and automatic clears are best effort:
 * their failures are swallowed and never fail a tool.
 *
 * One registry serves a session (stdio) or every request one HTTP caller provider serves, whose McpServer instances
 * live for a single request. Indicators are kept per address, so a later request (or a renewed OAuth token, which
 * brings a new client) can stop what an earlier one started; sends use the caller's latest client.
 */
import type { FmsgClient } from "./client/client.js";
import { FmsgHttpError } from "./client/errors.js";
import type { Caller } from "./context.js";

/** The emoji indicate shows by default: working on a reply. */
export const WORKING_EMOJI = "⏳";

export type IndicatorOptions = {
  /** How often an indicator is re-sent (default 30 s); never more often than half its ttl allows, nor below 1 s. */
  refreshMs?: number;
  /** How long an indicator is kept up before it is cleared (default 5 minutes). */
  maxMs?: number;
  /** Most indicators kept up at once per caller (default 10); the oldest is cleared to make room. */
  maxActive?: number;
  /** Debug log for swallowed failures; nothing is logged by default. */
  log?: (line: string) => void;
};

type Settings = Required<Omit<IndicatorOptions, "log">> & { log: (line: string) => void };

type Entry = { id: string; emoji: string; ttl: number; refreshMs: number; rootId: string | null; startedAt: number; timer?: NodeJS.Timeout };

/** A 4xx other than 401 (renewed by the client), 408 or 429 will not succeed on a retry; neither will a closed client. */
function permanent(error: unknown): boolean {
  if (error instanceof FmsgHttpError) return error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status);
  return error instanceof Error && error.name === "AbortError";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The indicators one caller shows. Sends for one message are serialized so a clear never overtakes a refresh. */
class CallerIndicators {
  private readonly entries = new Map<string, Entry>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(public client: FmsgClient, private readonly settings: Settings, private readonly onIdle: () => void) {}

  get idle(): boolean { return this.entries.size === 0 && this.tails.size === 0; }

  ids(): string[] { return [...this.entries.keys()]; }

  has(id: string): boolean { return this.entries.has(id); }

  private enqueue(id: string, emoji: string, ttl: number): Promise<void> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const sent = previous.then(() => this.client.indicate(id, emoji, ttl));
    const settled = sent.then(() => undefined, () => undefined);
    this.tails.set(id, settled);
    void settled.then(() => {
      if (this.tails.get(id) === settled) this.tails.delete(id);
      if (this.idle) this.onIdle();
    });
    return sent;
  }

  /** Send in the background, dropping the indicator when the host will never take it. */
  private sendQuietly(entry: Entry, emoji: string, ttl: number): void {
    this.enqueue(entry.id, emoji, ttl).catch((error: unknown) => {
      this.settings.log(`indicator on ${entry.id} failed: ${describe(error)}`);
      if (permanent(error) && this.entries.get(entry.id) === entry) this.stop(entry.id, false);
    });
  }

  private schedule(entry: Entry): void {
    const remaining = this.settings.maxMs - (Date.now() - entry.startedAt);
    entry.timer = setTimeout(() => this.tick(entry), Math.max(0, Math.min(entry.refreshMs, remaining)));
    entry.timer.unref?.();
  }

  private tick(entry: Entry): void {
    if (this.entries.get(entry.id) !== entry) return;
    if (Date.now() - entry.startedAt >= this.settings.maxMs) {
      this.stop(entry.id);
      return;
    }
    this.sendQuietly(entry, entry.emoji, entry.ttl);
    this.schedule(entry);
  }

  private add(id: string, emoji: string, ttl: number, rootId: string | null): Entry {
    this.stop(id, false);
    while (this.entries.size >= this.settings.maxActive) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.stop(oldest);
    }
    const refreshMs = Math.max(1000, Math.min(this.settings.refreshMs, Math.floor((ttl * 1000) / 2)));
    const entry: Entry = { id, emoji, ttl, refreshMs, rootId, startedAt: Date.now() };
    this.entries.set(id, entry);
    this.schedule(entry);
    return entry;
  }

  /**
   * Show `emoji` now, failing if the host refuses it, then keep it up. The send is queued before the old indicator stops
   * so this caller never looks idle (and is dropped from the registry) while replacing one.
   */
  async set(id: string, emoji: string, ttl: number, rootId: string | null): Promise<void> {
    rootId ??= this.entries.get(id)?.rootId ?? null;
    const sent = this.enqueue(id, emoji, ttl);
    this.stop(id, false);
    await sent;
    this.add(id, emoji, ttl, rootId);
  }

  /** Clear now, failing if the host refuses it. */
  async clear(id: string): Promise<void> {
    const sent = this.enqueue(id, "", 0);
    this.stop(id, false);
    await sent;
  }

  /** Stop refreshing; with `clear`, also clear the indicator in the background. */
  stop(id: string, clear = true): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    if (clear) {
      this.enqueue(id, "", 0).catch((error: unknown) => this.settings.log(`clearing indicator on ${id} failed: ${describe(error)}`));
    } else if (this.idle) this.onIdle();
  }

  stopThread(rootId: string): void {
    for (const entry of [...this.entries.values()]) if (entry.rootId === rootId || entry.id === rootId) this.stop(entry.id);
  }

  stopAll(clear: boolean): void {
    for (const id of [...this.entries.keys()]) this.stop(id, clear);
  }
}

export class IndicatorRegistry {
  private readonly callers = new Map<string, CallerIndicators>();
  private readonly settings: Settings;
  private closed = false;

  constructor(options: IndicatorOptions = {}) {
    this.settings = {
      refreshMs: options.refreshMs ?? 30_000,
      maxMs: options.maxMs ?? 5 * 60_000,
      maxActive: options.maxActive ?? 10,
      log: options.log ?? (() => undefined),
    };
  }

  /** The caller's indicators, if any, switched to its current client (a renewed OAuth token brings a new one). */
  private existing(caller: Caller): CallerIndicators | undefined {
    const indicators = this.callers.get(caller.address.toLowerCase());
    if (indicators) indicators.client = caller.client;
    return indicators;
  }

  private of(caller: Caller): CallerIndicators {
    const key = caller.address.toLowerCase();
    let indicators = this.existing(caller);
    if (!indicators) {
      const created = new CallerIndicators(caller.client, this.settings, () => {
        if (this.callers.get(key) === created && created.idle) this.callers.delete(key);
      });
      indicators = created;
      this.callers.set(key, created);
    }
    return indicators;
  }

  /** After a reply was sent to `parentId`: stop what is shown on it and anywhere in its thread. */
  replied(caller: Caller, parentId: string, rootId: string | null): void {
    const indicators = this.existing(caller);
    if (!indicators) return;
    indicators.stop(parentId);
    if (rootId) indicators.stopThread(rootId);
  }

  /** After a reaction or mark_read: the caller has handled these messages. */
  handled(caller: Caller, ids: string[]): void {
    const indicators = this.existing(caller);
    for (const id of ids) indicators?.stop(id);
  }

  /**
   * The indicate tool: show `emoji` and keep it up, or clear with an empty one. Throws the host's refusal. `rootId` is
   * the message's thread root, when known, so a reply anywhere in that thread stops it.
   */
  async indicate(caller: Caller, id: string, emoji: string, ttl: number, rootId: string | null = null): Promise<void> {
    if (!emoji) return this.of(caller).clear(id);
    if (this.closed) return caller.client.indicate(id, emoji, ttl);
    return this.of(caller).set(id, emoji, ttl, rootId);
  }

  /** Message ids with an indicator kept up for this caller. */
  active(caller: Caller): string[] {
    return this.callers.get(caller.address.toLowerCase())?.ids() ?? [];
  }

  /** Stop every indicator, clearing them in the background. Idempotent. */
  close(): void {
    this.closed = true;
    for (const indicators of this.callers.values()) indicators.stopAll(true);
  }
}
