import type { AuthInfo } from "@modelcontextprotocol/server";
import type { SearchSupport } from "./client/types.js";
import { type Caller, type CallerProvider, UnconfiguredCallerProvider } from "./context.js";

/**
 * Whether each Web API implements the optional `GET /fmsg/search`, remembered per API URL so that `search_messages`
 * is listed only where it works. A definite answer is kept for `ttlMs`, so a Web API that starts implementing search
 * gains the tool without a restart. "unknown" (the host was unreachable or the probe timed out) is never kept and
 * counts as supported: better a tool that explains a refusal than one hidden by a passing failure.
 */
export class SearchSupportCache {
  private readonly known = new Map<string, { supported: boolean; until: number }>();
  private readonly pending = new Map<string, Promise<SearchSupport>>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly timeoutMs = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The remembered answer for apiUrl, if still fresh. */
  cached(apiUrl: string): boolean | undefined {
    const entry = this.known.get(apiUrl);
    return entry && entry.until > this.now() ? entry.supported : undefined;
  }

  /** The last answer for apiUrl, however old. */
  lastKnown(apiUrl: string): boolean | undefined {
    return this.known.get(apiUrl)?.supported;
  }

  /**
   * Whether apiUrl implements search: the remembered answer, else the result of probe (shared by concurrent callers
   * and bounded by the timeout). Never rejects.
   */
  async supported(apiUrl: string, probe: (signal: AbortSignal) => Promise<SearchSupport>): Promise<boolean> {
    const cached = this.cached(apiUrl);
    if (cached !== undefined) return cached;
    let running = this.pending.get(apiUrl);
    if (!running) {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const timedOut = new Promise<SearchSupport>((resolve) => signal.addEventListener("abort", () => resolve("unknown"), { once: true }));
      running = Promise.race([probe(signal).catch((): SearchSupport => "unknown"), timedOut])
        .finally(() => this.pending.delete(apiUrl));
      this.pending.set(apiUrl, running);
    }
    const result = await running;
    if (result !== "unknown") this.remember(apiUrl, result === "yes");
    return result !== "no";
  }

  /** Record a definite answer, such as a call refused with 501. */
  remember(apiUrl: string, supported: boolean): void {
    this.known.set(apiUrl, { supported, until: this.now() + this.ttlMs });
  }
}

/** The process-wide cache the transports and the tool share. */
export const searchSupport = new SearchSupportCache();

/**
 * Whether to list search_messages for this request's caller. The answer is remembered per Web API. When it is out of
 * date, the Web API is asked again only if that needs no token exchange (the caller already holds a Web API token,
 * or `exchange` is set, as over stdio): listing tools over OAuth must not start one. Otherwise the last answer
 * stands, and with none yet the tool is listed. A server without credentials lists no search tool; a caller that
 * can't be resolved for another reason (the host is unreachable) gets it, like every other tool.
 */
export async function searchAvailable(
  provider: CallerProvider, authInfo: AuthInfo | undefined,
  { exchange = false, cache = searchSupport }: { exchange?: boolean; cache?: SearchSupportCache } = {},
): Promise<boolean> {
  let caller: Caller;
  try {
    caller = await provider.forRequest(authInfo);
  } catch {
    return !(provider instanceof UnconfiguredCallerProvider);
  }
  const apiUrl = caller.client.apiUrl;
  const fresh = cache.cached(apiUrl);
  if (fresh !== undefined) return fresh;
  if (exchange || caller.client.hasToken()) return cache.supported(apiUrl, (signal) => caller.client.searchSupported(signal));
  return cache.lastKnown(apiUrl) ?? true;
}
