import { createRemoteJWKSet, customFetch, decodeJwt, decodeProtectedHeader, jwtVerify, errors } from "jose";
import { normalizeFmsgAddress } from "../address.js";
import { readBytes } from "../client/stream.js";
import type { AccessToken } from "../client/types.js";
import { oauthUrl, type OAuthConfig } from "./config.js";
import { invalidToken, OAuthRequestError } from "./errors.js";
import { parseScopes } from "./scopes.js";

export type OAuthIdentity = { address: string; expiresAtMs: number; scopes: string[]; clientId: string };
type Metadata = { token_endpoint: string; jwks_uri: string };
export const EXCHANGE_CACHE_MAX_MS = 300_000;

/** One configured authorization server. No endpoint is taken from an incoming JWT. */
export class OAuthIssuer {
  private metadata?: { value: Metadata; expiresAt: number };
  private loading?: Promise<Metadata>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private jwksUrl?: string;
  private readonly lifetime = new AbortController();

  constructor(private readonly config: OAuthConfig, private readonly log: (line: string) => void) {}

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    this.lifetime.signal.throwIfAborted();
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5000), ...(init.signal ? [init.signal] : [])]);
    try {
      const response = await fetch(url, { ...init, signal, redirect: "error" });
      const { data } = await readBytes(response.body, 65_536);
      return new Response(data as Uint8Array<ArrayBuffer>, { status: response.status, headers: response.headers });
    } catch {
      if (init.signal?.aborted) throw init.signal.reason;
      throw new OAuthRequestError(503, "temporarily_unavailable", "The authorization service is unavailable.");
    }
  }

  private configurationError(code: string): OAuthRequestError {
    this.log(`OAuth operator action required: ${code}; check issuer and exchange configuration`);
    return new OAuthRequestError(500, "server_error", "The OAuth server configuration needs operator attention.");
  }

  async discover(): Promise<Metadata> {
    this.lifetime.signal.throwIfAborted();
    if (this.metadata && this.metadata.expiresAt > Date.now()) return this.metadata.value;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const issuer = new URL(this.config.issuerUrl);
      const path = issuer.pathname === "/" ? "" : issuer.pathname;
      let response = await this.fetch(`${issuer.origin}/.well-known/oauth-authorization-server${path}`);
      if (response.status === 404) response = await this.fetch(`${this.config.issuerUrl.replace(/\/$/u, "")}/.well-known/openid-configuration`);
      if (!response.ok) throw new OAuthRequestError(503, "temporarily_unavailable", "OAuth discovery is unavailable.");
      let value: Record<string, unknown>;
      try { value = await response.json() as Record<string, unknown>; } catch { throw this.configurationError("invalid discovery document"); }
      if (!value || value.issuer !== this.config.issuerUrl || typeof value.jwks_uri !== "string" || typeof value.token_endpoint !== "string") {
        throw this.configurationError("discovery issuer or endpoints do not match");
      }
      let result: Metadata;
      try { result = { token_endpoint: oauthUrl(value.token_endpoint, "token endpoint", true), jwks_uri: oauthUrl(value.jwks_uri, "JWKS endpoint", true) }; }
      catch { throw this.configurationError("invalid discovery endpoint URL"); }
      if (result.jwks_uri !== this.jwksUrl) {
        this.jwks = createRemoteJWKSet(new URL(result.jwks_uri), {
          cacheMaxAge: 300_000, cooldownDuration: 5000,
          [customFetch]: (url, init) => this.fetch(String(url), init),
        });
        this.jwksUrl = result.jwks_uri;
      }
      this.metadata = { value: result, expiresAt: Date.now() + 300_000 };
      return result;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  async verify(token: string): Promise<OAuthIdentity> {
    if (token.length > 16_384) throw invalidToken();
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== "EdDSA" || header.typ !== "at+jwt" || typeof header.kid !== "string" || !header.kid) throw invalidToken();
    } catch { throw invalidToken(); }
    await this.discover();
    try {
      const { payload } = await jwtVerify(token, this.jwks!, {
        algorithms: ["EdDSA"], typ: "at+jwt", issuer: this.config.issuerUrl,
        audience: this.config.resourceUrl, requiredClaims: ["iss", "aud", "exp", "sub"],
      });
      const audience = Array.isArray(payload.aud) && payload.aud.length === 1 ? payload.aud[0] : payload.aud;
      const claim = payload[this.config.addressClaim];
      const address = typeof claim === "string" ? normalizeFmsgAddress(claim) : undefined;
      const scopes = parseScopes(payload.scope);
      const expiresAtMs = Math.floor(payload.exp! * 1000);
      if (audience !== this.config.resourceUrl || !address || !scopes || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) throw invalidToken();
      return { address, scopes, expiresAtMs, clientId: typeof payload.client_id === "string" ? payload.client_id : "oauth-client" };
    } catch (error) {
      if (error instanceof OAuthRequestError) throw error;
      if (error instanceof errors.JOSEError) throw invalidToken();
      throw new OAuthRequestError(503, "temporarily_unavailable", "OAuth token verification is unavailable.");
    }
  }

  async exchange(subjectToken: string, identity: OAuthIdentity, signal: AbortSignal): Promise<AccessToken> {
    if (identity.expiresAtMs <= Date.now()) throw invalidToken();
    const metadata = await this.discover();
    signal.throwIfAborted();
    const startedAt = Date.now();
    const requestedScopes: string[] = identity.scopes.filter(scope => scope === "fmsg:read" || scope === "fmsg:write");
    // RFC 6749 section 2.3.1: form-encode each component before HTTP Basic.
    const encode = (value: string) => new URLSearchParams({ x: value }).toString().slice(2);
    const basic = Buffer.from(`${encode(this.config.clientId)}:${encode(this.config.clientSecret)}`).toString("base64");
    const response = await this.fetch(metadata.token_endpoint, {
      method: "POST", signal,
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: subjectToken, subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        audience: this.config.exchangeAudience,
        scope: requestedScopes.join(" "),
      }),
    });
    // The subject can expire during discovery/exchange or response transfer.
    // That is a normal reconnect, not an operator configuration failure.
    if (identity.expiresAtMs <= Date.now()) throw invalidToken();
    let body: Record<string, unknown>;
    try { body = await response.json() as Record<string, unknown>; } catch { throw this.configurationError("invalid exchange response"); }
    if (!body || !response.ok) {
      if (body?.error === "invalid_grant") throw invalidToken();
      if (body?.error === "invalid_client" || body?.error === "invalid_target") throw this.configurationError(body.error);
      throw new OAuthRequestError(503, "temporarily_unavailable", "OAuth token exchange is unavailable.");
    }
    try {
      if (typeof body.access_token !== "string" || body.access_token === subjectToken ||
        typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0 ||
        typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer" ||
        body.issued_token_type !== "urn:ietf:params:oauth:token-type:access_token" || body.refresh_token !== undefined) throw new Error();
      // The authenticated token endpoint is trusted to issue the token. Check its
      // contract before use; the Web API verifies its signature, issuer and rights.
      const claims = decodeJwt(body.access_token);
      const header = decodeProtectedHeader(body.access_token);
      const scopes = parseScopes(body.scope);
      const tokenScopes = parseScopes(claims.scope);
      const audience = Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud;
      if (header.alg !== "EdDSA" || header.typ !== "at+jwt" || audience !== this.config.exchangeAudience ||
        typeof claims.sub !== "string" || normalizeFmsgAddress(claims.sub) !== identity.address ||
        typeof claims.exp !== "number" || !Number.isFinite(claims.exp) ||
        !scopes || !tokenScopes || scopes.some(scope => !requestedScopes.includes(scope)) ||
        tokenScopes.some(scope => !scopes.includes(scope)) || scopes.some(scope => !tokenScopes.includes(scope))) throw new Error();
      const expiresAtMs = Math.min(startedAt + body.expires_in * 1000, claims.exp * 1000, identity.expiresAtMs, startedAt + EXCHANGE_CACHE_MAX_MS);
      if (expiresAtMs <= Date.now()) throw new Error();
      return { accessToken: body.access_token, address: identity.address, expiresAtMs };
    } catch {
      if (identity.expiresAtMs <= Date.now()) throw invalidToken();
      throw this.configurationError("exchange returned an unexpected token or scope");
    }
  }

  close(): void { this.lifetime.abort(); this.config.clientSecret = ""; this.metadata = undefined; this.jwks = undefined; }
}
