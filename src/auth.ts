import { createHash } from "node:crypto";
import { type AuthInfo, OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { FmsgClient, FmsgHttpError } from "./client/client.js";
import { safeErrorMessage } from "./client/redact.js";
import type { Config } from "./config.js";
import type { Caller, CallerProvider } from "./context.js";

export const FMSG_SCOPE = "fmsg";
type Entry = { caller: Caller; lastUsed: number };

/**
 * Per-key upstream clients. Hashes index the cache; clients retain raw keys in
 * memory for token renewal. The Web API remains authoritative for access.
 */
export class ApiKeyCallerProvider implements CallerProvider, OAuthTokenVerifier {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private readonly pendingClients = new Set<FmsgClient>();
  // Keep a request's caller stable even if another request evicts its cache entry.
  private authenticated = new WeakMap<AuthInfo, Entry>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly config: Config,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    this.timer = setInterval(() => this.evict(), Math.min(config.http.keyCacheTtlMs, 30_000)).unref();
  }

  static cacheKey(apiKey: string): string {
    return createHash("sha256").update(apiKey).digest("hex");
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsed >= this.config.http.keyCacheTtlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.config.http.keyCacheMax) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
    // Evicted clients still in use by requests are released with those requests.
  }

  private async createEntry(token: string, key: string): Promise<Entry> {
    const client = new FmsgClient(this.config.apiUrl, token, { allowInsecureHttp: this.config.allowInsecureHttp });
    this.pendingClients.add(client);
    try {
      const address = await client.address();
      if (this.closed) throw new Error("server is closing");
      const entry = { caller: { client, address, tokenExpiresAt: async () => (await client.getToken()).expiresAtMs }, lastUsed: Date.now() };
      this.entries.set(key, entry);
      this.evict();
      this.log(safeErrorMessage(`authenticated ${address} (key ${key.slice(0, 8)}…)`));
      return entry;
    } catch (error) {
      client.close();
      throw error;
    } finally {
      this.pendingClients.delete(client);
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.closed) throw new OAuthError(OAuthErrorCode.ServerError, "server is closing");
    if (!token.startsWith("fmsgk_")) throw new OAuthError(OAuthErrorCode.InvalidToken, "bearer token must be an fmsg API key (fmsgk_...)");
    const key = ApiKeyCallerProvider.cacheKey(token);
    this.evict();
    try {
      let entry = this.entries.get(key);
      if (!entry) {
        let pending = this.pending.get(key);
        if (!pending) {
          if (this.pending.size >= this.config.http.keyCacheMax) throw new Error("too many concurrent token exchanges");
          pending = this.createEntry(token, key);
          this.pending.set(key, pending);
          void pending.finally(() => this.pending.delete(key)).catch(() => undefined);
        }
        entry = await pending;
      }
      entry.lastUsed = Date.now();
      const expiresAtMs = await entry.caller.tokenExpiresAt();
      if (this.closed) throw new Error("server is closing");
      const auth: AuthInfo = {
        token: key,
        clientId: entry.caller.address,
        scopes: [FMSG_SCOPE],
        expiresAt: Math.floor(expiresAtMs / 1000),
        extra: { cacheKey: key },
      };
      this.authenticated.set(auth, entry);
      return auth;
    } catch (error) {
      this.entries.delete(key);
      this.log(safeErrorMessage(`token exchange failed for ${key.slice(0, 8)}…: ${safeErrorMessage(error)}`));
      if (error instanceof FmsgHttpError && [400, 401, 403].includes(error.status)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, `fmsg host rejected the API key: ${safeErrorMessage(error)}`);
      }
      throw new OAuthError(OAuthErrorCode.ServerError, "fmsg host unavailable for token exchange");
    }
  }

  async forRequest(authInfo: AuthInfo | undefined): Promise<Caller> {
    const entry = authInfo ? this.authenticated.get(authInfo) : undefined;
    if (this.closed || !entry) throw new Error("not authenticated: send your fmsg API key as `Authorization: Bearer fmsgk_...`");
    entry.lastUsed = Date.now();
    return entry.caller;
  }

  invalidate(caller: Caller): void {
    for (const [key, entry] of this.entries) if (entry.caller === caller) this.entries.delete(key);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const { caller } of this.entries.values()) caller.client.close();
    for (const client of this.pendingClients) client.close();
    this.entries.clear();
    this.pending.clear();
    this.authenticated = new WeakMap();
  }

  get size(): number { return this.entries.size; }
}
