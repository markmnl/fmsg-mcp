import { createHash } from "node:crypto";
import { type AuthInfo, OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { FmsgClient, FmsgHttpError } from "./client/client.js";
import type { Config } from "./config.js";
import type { Caller, CallerProvider } from "./context.js";

export const FMSG_SCOPE = "fmsg";

type Entry = { caller: Caller; lastUsed: number };

/**
 * HTTP mode: each request carries an fmsg API key as its bearer token. The key
 * is exchanged once at the fmsg host, and the resulting client (which renews
 * its own JWT) is cached by the key's hash. Raw keys are never stored or logged.
 */
export class ApiKeyCallerProvider implements CallerProvider, OAuthTokenVerifier {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly config: Config,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  static cacheKey(apiKey: string): string {
    return createHash("sha256").update(apiKey).digest("hex");
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsed > this.config.http.keyCacheTtlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.config.http.keyCacheMax) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
  }

  /** Bearer verifier for the MCP gate: exchange the key, return the caller's identity. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!token.startsWith("fmsgk_")) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "bearer token must be an fmsg API key (fmsgk_...)");
    }
    const key = ApiKeyCallerProvider.cacheKey(token);
    let entry = this.entries.get(key);
    if (!entry) {
      const client = new FmsgClient(this.config.apiUrl, token);
      let address: string;
      try {
        address = await client.address();
      } catch (error) {
        if (error instanceof FmsgHttpError && (error.status === 401 || error.status === 403 || error.status === 400)) {
          this.log(`rejected api key ${key.slice(0, 8)}…: ${error.status} ${error.message}`);
          throw new OAuthError(OAuthErrorCode.InvalidToken, `fmsg host rejected the API key: ${error.message}`);
        }
        this.log(`token exchange failed for ${key.slice(0, 8)}…: ${error instanceof Error ? error.message : String(error)}`);
        throw new OAuthError(OAuthErrorCode.ServerError, "fmsg host unavailable for token exchange");
      }
      entry = {
        caller: { client, address, tokenExpiresAt: async () => (await client.getToken()).expiresAtMs },
        lastUsed: Date.now(),
      };
      this.entries.set(key, entry);
      this.evict();
      this.log(`authenticated ${address} (key ${key.slice(0, 8)}…)`);
    }
    entry.lastUsed = Date.now();
    const expiresAtMs = await entry.caller.tokenExpiresAt();
    return {
      token: key,
      clientId: entry.caller.address,
      scopes: [FMSG_SCOPE],
      expiresAt: Math.floor(expiresAtMs / 1000),
      extra: { cacheKey: key },
    };
  }

  async forRequest(authInfo: AuthInfo | undefined): Promise<Caller> {
    const key = typeof authInfo?.extra?.cacheKey === "string" ? authInfo.extra.cacheKey : authInfo?.token;
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry) throw new Error("not authenticated: send your fmsg API key as `Authorization: Bearer fmsgk_...`");
    entry.lastUsed = Date.now();
    return entry.caller;
  }

  get size(): number {
    return this.entries.size;
  }
}
