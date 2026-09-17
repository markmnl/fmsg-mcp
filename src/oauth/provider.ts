import { createHash, randomUUID } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { FmsgClient } from "../client/client.js";
import type { Config } from "../config.js";
import type { Caller, CallerProvider } from "../context.js";
import { invalidToken } from "./errors.js";
import { OAuthIssuer, EXCHANGE_CACHE_MAX_MS, type OAuthIdentity } from "./issuer.js";

type Entry = { key: string; caller: Caller; identity: OAuthIdentity; active: number; lastUsed: number };

/** Each incoming token owns its own client/cache. Opaque request leases survive SDK cloning. */
export class OAuthCallerProvider implements CallerProvider {
  readonly issuer: OAuthIssuer;
  private readonly entries = new Map<string, Entry>();
  private readonly leases = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly config: Config, log: (line: string) => void) {
    this.issuer = new OAuthIssuer({ ...config.oauth! }, log);
    this.timer = setInterval(() => this.evict(), 30_000).unref();
  }

  private drop(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (!entry.active) entry.caller.client.close();
  }

  private evict(): void {
    for (const entry of this.entries.values()) {
      if (entry.identity.expiresAtMs <= Date.now() || Date.now() - entry.lastUsed >= EXCHANGE_CACHE_MAX_MS) this.drop(entry);
    }
    while (this.entries.size > this.config.http.keyCacheMax) this.drop(this.entries.values().next().value!);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.closed) throw invalidToken();
    const identity = await this.issuer.verify(token);
    if (this.closed) throw invalidToken();
    this.evict();
    const key = createHash("sha256").update(token).digest("hex");
    let entry = this.entries.get(key);
    if (!entry) {
      let subject = token;
      const client = new FmsgClient(this.config.apiUrl, {
        getToken: ({ signal }) => this.issuer.exchange(subject, identity, signal),
        close: () => { subject = ""; },
      }, { allowInsecureHttp: this.config.allowInsecureHttp, reconnectOnTokenExpiry: true });
      entry = { key, identity, active: 0, lastUsed: Date.now(), caller: {
        client, address: identity.address, tokenExpiresAt: async () => (await client.getToken()).expiresAtMs,
      } };
      this.entries.set(key, entry);
    }
    entry.active++;
    entry.lastUsed = Date.now();
    this.evict();
    const lease = randomUUID();
    this.leases.set(lease, entry);
    return { token: key, clientId: identity.clientId, scopes: identity.scopes, expiresAt: identity.expiresAtMs / 1000,
      extra: { callerLease: lease, address: identity.address } };
  }

  private entryFor(auth: AuthInfo | undefined): Entry | undefined {
    const lease = auth?.extra?.callerLease;
    const entry = typeof lease === "string" ? this.leases.get(lease) : undefined;
    return entry && auth?.token === entry.key && auth.clientId === entry.identity.clientId && auth.extra?.address === entry.identity.address ? entry : undefined;
  }

  async forRequest(auth: AuthInfo | undefined): Promise<Caller> {
    const entry = this.entryFor(auth);
    if (this.closed || !entry || entry.identity.expiresAtMs <= Date.now()) throw invalidToken();
    return entry.caller;
  }

  release(auth: AuthInfo): void {
    const entry = this.entryFor(auth);
    if (!entry) return;
    this.leases.delete(auth.extra!.callerLease as string);
    entry.active--;
    if (!entry.active && this.entries.get(entry.key) !== entry) entry.caller.client.close();
  }

  invalidate(caller: Caller): void {
    for (const entry of this.entries.values()) if (entry.caller === caller) this.drop(entry);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.issuer.close();
    for (const entry of [...this.entries.values(), ...this.leases.values()]) entry.caller.client.close();
    this.entries.clear(); this.leases.clear();
  }

  get size(): number { return this.entries.size; }
}
