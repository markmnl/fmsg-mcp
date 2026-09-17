import { normalizeFmsgAddress } from "../address.js";
import { FmsgHttpError, readError } from "./errors.js";
import type { AccessToken } from "./types.js";

export type TokenProviderRequest = {
  /** Normalized Web API URL this client is bound to. */
  readonly apiUrl: string;
  /** Aborted on timeout, client close, or cancellation by all waiting callers. */
  readonly signal: AbortSignal;
  /** A protected request rejected the previous token, or renewal was explicitly forced. */
  readonly forceRefresh: boolean;
};

/**
 * Supplies a fresh Web API access token for one caller and authorization grant.
 * FmsgClient owns caching and concurrent renewal. Never return an incoming MCP
 * token or use a provider across different callers/grants. See docs/token-providers.md.
 */
export interface TokenProvider {
  getToken(request: TokenProviderRequest): Promise<AccessToken>;
  /** Release credentials/resources. Called once by FmsgClient.close(). */
  close?(): void;
}

/** Existing API-key exchange, behind the same interface as future OAuth adapters. */
export class ApiKeyTokenProvider implements TokenProvider {
  constructor(private apiKey: string, private readonly fetchImpl: typeof fetch) {
    if (!apiKey.startsWith("fmsgk_")) throw new Error("fmsg API key must start with fmsgk_");
  }

  async getToken({ apiUrl, signal }: TokenProviderRequest): Promise<AccessToken> {
    const response = await this.fetchImpl(`${apiUrl}/fmsg/token`, {
      method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, redirect: "error", signal,
    });
    if (!response.ok) {
      const { message, code } = await readError(response);
      throw new FmsgHttpError(`token exchange failed: ${message}`, response.status, "POST", "/fmsg/token", code);
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown; expires_at?: unknown };
    if (typeof body.access_token !== "string") throw new Error("token response has no access_token");
    const payload = decodeJwtPayload(body.access_token);
    const address = typeof payload.sub === "string" ? normalizeFmsgAddress(payload.sub) : undefined;
    if (!address) throw new Error("token JWT sub is not an fmsg address");
    const expiries = [
      typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN,
      typeof payload.exp === "number" ? payload.exp * 1000 : Number.NaN,
      typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : Number.NaN,
    ].filter(Number.isFinite);
    // Never extend the JWT lifetime using a later response expiry or a guessed TTL.
    const expiresAtMs = expiries.length ? Math.min(...expiries) : Number.NaN;
    return { accessToken: body.access_token, address, expiresAtMs };
  }

  close(): void { this.apiKey = ""; }
}

// Only the first-party API-key contract requires sub/exp in a JWT. Custom
// providers supply address/expiry metadata; the client does not decode their tokens.
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("token exchange returned an invalid JWT");
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch {
    throw new Error("token exchange returned an unreadable JWT payload");
  }
}
