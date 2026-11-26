import type { AuthInfo } from "@modelcontextprotocol/server";
import type { SearchSupport } from "./client/types.js";
import { type Caller, type CallerProvider, UnconfiguredCallerProvider } from "./context.js";

/**
 * Whether each Web API implements the optional `GET /fmsg/search`, remembered per API URL so that `search_messages`
 * is listed only where it works. A definite answer is kept for `ttlMs`, so a Web API that starts implementing search
 * gains the tool without a restart. "unknown" (the host was unreachable or the probe timed out) is never kept as an
 * answer and counts as supported: better a tool that explains a refusal than one hidden by a passing failure. It
 * does hold the next probe off for `retryMs`, so a Web API that can't answer isn't asked again by every request.
 */
export class SearchSupportCache {
  private readonly known = new Map<string, { supported: boolean; until: number }>();
  private readonly pending = new Map<string, Promise<SearchSupport>>();
  /** When each Web API may be asked again after a probe that could not tell. */
  private readonly retryAt = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly timeoutMs = 2_000,
    private readonly now: () => number = Date.now,
    private readonly retryMs = 60_000,
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

  /** Ask apiUrl again in the background, unless already asking; the answer is remembered for the next caller. */
  refresh(apiUrl: string, probe: (signal: AbortSignal) => Promise<SearchSupport>): void {
    void this.supported(apiUrl, probe);
  }

  /** The probe under way for apiUrl, if any (for tests). */
  pendingFor(apiUrl: string): Promise<SearchSupport> | undefined {
    return this.pending.get(apiUrl);
  }

  /**
   * Whether apiUrl implements search: the remembered answer, else the result of probe (shared by concurrent callers
   * and bounded by the timeout). After a probe that could not tell, the last answer (or "supported" when there is
   * none) stands for `retryMs` without asking again. Never rejects.
   */
  async supported(apiUrl: string, probe: (signal: AbortSignal) => Promise<SearchSupport>): Promise<boolean> {
    const cached = this.cached(apiUrl);
    if (cached !== undefined) return cached;
    if ((this.retryAt.get(apiUrl) ?? 0) > this.now()) return this.lastKnown(apiUrl) ?? true;
    let running = this.pending.get(apiUrl);
    if (!running) {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const timedOut = new Promise<SearchSupport>((resolve) => signal.addEventListener("abort", () => resolve("unknown"), { once: true }));
      running = Promise.race([probe(signal).catch((): SearchSupport => "unknown"), timedOut])
        .then((result) => {
          if (result === "unknown") this.retryAt.set(apiUrl, this.now() + this.retryMs);
          else this.remember(apiUrl, result === "yes");
          return result;
        })
        .finally(() => this.pending.delete(apiUrl));
      this.pending.set(apiUrl, running);
    }
    return (await running) !== "no";
  }

  /** Record a definite answer, such as a call refused with 501. */
  remember(apiUrl: string, supported: boolean): void {
    this.known.set(apiUrl, { supported, until: this.now() + this.ttlMs });
    this.retryAt.delete(apiUrl);
  }
}

/** The process-wide cache the transports and the tool share. */
export const searchSupport = new SearchSupportCache();

/**
 * Whether to list search_messages for this request's caller. The answer is remembered per Web API. When it is out of
 * date, the last answer stands for this request while the Web API is asked again in the background, so no request
 * waits on it; only the first answer is awaited. The Web API is asked only if that needs no token exchange (the
 * caller already holds a Web API token, or `exchange` is set, as over stdio): listing tools over OAuth must not
 * start one. With no answer yet and no token, the tool is listed. A server without credentials lists no search tool; a caller that
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
  const last = cache.lastKnown(apiUrl);
  if (!exchange && !caller.client.hasToken()) return last ?? true;
  const probe = (signal: AbortSignal) => caller.client.searchSupported(signal);
  if (last === undefined) return cache.supported(apiUrl, probe);
  cache.refresh(apiUrl, probe);
  return last;
}
