import { createHash, randomUUID } from "node:crypto";
import { type AuthInfo, OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { FmsgClient, FmsgHttpError } from "./client/client.js";
import { safeErrorMessage } from "./client/redact.js";
import type { Config } from "./config.js";
import type { Caller, CallerProvider } from "./context.js";

export const FMSG_SCOPE = "fmsg";
type Entry = { key: string; caller: Caller; lastUsed: number; active: number };

/** Per-key clients retain credentials for renewal; upstream decides access. */
export class ApiKeyCallerProvider implements CallerProvider, OAuthTokenVerifier {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private readonly pendingClients = new Set<FmsgClient>();
  // An opaque request lease survives SDK cloning and pins the caller across eviction.
  private readonly leases = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly config: Config, private readonly log: (line: string) => void = () => undefined) {
    this.timer = setInterval(() => this.evict(), Math.min(config.http.keyCacheTtlMs, 30_000)).unref();
  }

  static cacheKey(apiKey: string): string { return createHash("sha256").update(apiKey).digest("hex"); }

  private releaseEntry(entry: Entry): void {
    if (!entry.active && this.entries.get(entry.key) !== entry) entry.caller.client.close();
  }

  private drop(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    this.releaseEntry(entry);
  }

  private evict(): void {
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (now - entry.lastUsed >= this.config.http.keyCacheTtlMs) this.drop(entry);
    }
    while (this.entries.size > this.config.http.keyCacheMax) {
      const oldest = [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) break;
      this.drop(oldest);
    }
  }

  private async createEntry(token: string, key: string): Promise<Entry> {
    const client = new FmsgClient(this.config.apiUrl, token, { allowInsecureHttp: this.config.allowInsecureHttp });
    this.pendingClients.add(client);
    try {
      const address = await client.address();
      if (this.closed) throw new Error("server is closing");
      const entry: Entry = { key, caller: { client, address, tokenExpiresAt: async () => (await client.getToken()).expiresAtMs }, lastUsed: Date.now(), active: 0 };
      this.entries.set(key, entry);
      this.log(safeErrorMessage(`authenticated ${address} (key ${key.slice(0, 8)}…)`));
      return entry;
    } catch (error) { client.close(); throw error; }
    finally { this.pendingClients.delete(client); }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.closed) throw new OAuthError(OAuthErrorCode.ServerError, "server is closing");
    if (!token.startsWith("fmsgk_")) throw new OAuthError(OAuthErrorCode.InvalidToken, "bearer token must be an fmsg API key (fmsgk_...)");
    const key = ApiKeyCallerProvider.cacheKey(token);
    this.evict();
    let entry: Entry | undefined;
    try {
      entry = this.entries.get(key);
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
      entry.active++;
      entry.lastUsed = Date.now();
      this.evict();
      const expiresAtMs = await entry.caller.tokenExpiresAt();
      if (this.closed) throw new Error("server is closing");
      const lease = randomUUID();
      this.leases.set(lease, entry);
      return {
        token: key, clientId: entry.caller.address, scopes: [FMSG_SCOPE],
        expiresAt: Math.floor(expiresAtMs / 1000), extra: { cacheKey: key, callerLease: lease },
      };
    } catch (error) {
      if (entry) { entry.active--; this.drop(entry); }
      this.log(safeErrorMessage(`token exchange failed for ${key.slice(0, 8)}…: ${error instanceof Error ? error.message : String(error)}`));
      if (error instanceof FmsgHttpError && [400, 401, 403].includes(error.status)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, `fmsg host rejected the API key: ${safeErrorMessage(error)}`);
      }
      throw new OAuthError(OAuthErrorCode.ServerError, "fmsg host unavailable for token exchange");
    }
  }

  private entryFor(auth: AuthInfo | undefined): Entry | undefined {
    const lease = auth?.extra?.callerLease;
    const entry = typeof lease === "string" ? this.leases.get(lease) : undefined;
    return entry && auth?.token === entry.key && auth.extra?.cacheKey === entry.key &&
      auth.clientId === entry.caller.address && auth.scopes.includes(FMSG_SCOPE) ? entry : undefined;
  }

  async forRequest(authInfo: AuthInfo | undefined): Promise<Caller> {
    const entry = this.entryFor(authInfo);
    if (this.closed || !entry) throw new Error("not authenticated: send your fmsg API key as `Authorization: Bearer fmsgk_...`");
    entry.lastUsed = Date.now();
    return entry.caller;
  }

  /** The HTTP adapter releases this lease when the response or connection ends. */
  release(authInfo: AuthInfo): void {
    const entry = this.entryFor(authInfo);
    if (!entry) return;
    this.leases.delete(authInfo.extra!.callerLease as string);
    entry.active--;
    this.releaseEntry(entry);
  }

  invalidate(caller: Caller): void {
    for (const entry of this.entries.values()) if (entry.caller === caller) this.drop(entry);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const entry of [...this.entries.values(), ...this.leases.values()]) entry.caller.client.close();
    for (const client of this.pendingClients) client.close();
    this.entries.clear(); this.leases.clear(); this.pending.clear();
  }

  get size(): number { return this.entries.size; }
}
