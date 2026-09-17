/** Local RFC 8414/8693 fixture with real signatures, independent OAuth/API keys. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTHeaderParameters } from "jose";
import type { OAuthConfig } from "../src/oauth/config.js";
import type { FakeFmsgServer } from "./fake-fmsg-server.js";
import { ALICE } from "./helpers.js";

export class FakeOAuthServer {
  private readonly server = createServer((req, res) => void this.handle(req, res).catch(() => {
    res.writeHead(500); res.end();
  }));
  keys!: Awaited<ReturnType<typeof generateKeyPair>>;
  apiKeys!: Awaited<ReturnType<typeof generateKeyPair>>;
  baseUrl = "";
  kid = "oauth-key";
  exchangeTtl = 300;
  exchangeError?: string;
  discoveryOverride: Record<string, unknown> = {};
  responseOverride: Record<string, unknown> = {};
  exchangedClaims: JWTPayload = {};
  readonly revoked = new Set<string>();
  readonly requests: string[] = [];
  readonly exchanges: Array<{ form: URLSearchParams; authorization?: string; token?: string }> = [];
  onExchange?: () => Promise<void>;

  constructor(private readonly api: FakeFmsgServer) {}

  get config(): OAuthConfig {
    return { resourceUrl: "https://mcp.example.com/mcp", issuerUrl: `${this.baseUrl}/oauth`, clientId: "mcp-server",
      clientSecret: "fixture secret:+&", exchangeAudience: "https://api.example.com/fmsg", addressClaim: "sub" };
  }

  async start(): Promise<void> {
    this.keys = await generateKeyPair("EdDSA");
    this.apiKeys = await generateKeyPair("EdDSA");
    await new Promise<void>(resolve => this.server.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
  }

  async token(claims: JWTPayload = {}, header: Partial<JWTHeaderParameters> = {}, key = this.keys.privateKey): Promise<string> {
    return new SignJWT({ iss: this.config.issuerUrl, aud: this.config.resourceUrl, sub: ALICE,
      exp: Math.floor(Date.now() / 1000) + 600, nbf: Math.floor(Date.now() / 1000) - 1,
      scope: "fmsg:read fmsg:write", client_id: "test-agent", jti: randomUUID(), ...claims,
    }).setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: this.kid, ...header }).sign(key);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requests.push(req.url!);
    const path = new URL(req.url!, this.baseUrl).pathname;
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/.well-known/oauth-authorization-server/oauth") {
      return json(200, { issuer: this.config.issuerUrl, jwks_uri: `${this.baseUrl}/oauth/jwks.json`,
        token_endpoint: `${this.baseUrl}/oauth/token`, ...this.discoveryOverride });
    }
    if (path === "/oauth/jwks.json") return json(200, { keys: [{ ...await exportJWK(this.keys.publicKey), kid: this.kid, use: "sig", alg: "EdDSA" }] });
    if (path === "/.well-known/jwks.json") return json(200, { keys: [{ ...await exportJWK(this.apiKeys.publicKey), kid: "api-key" }] });
    if (path !== "/oauth/token" || req.method !== "POST") return json(404, {});
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const entry: (typeof this.exchanges)[number] = { form, authorization: req.headers.authorization };
    this.exchanges.push(entry);
    await this.onExchange?.();
    const encode = (value: string) => new URLSearchParams({ x: value }).toString().slice(2);
    const expected = `Basic ${Buffer.from(`${encode(this.config.clientId)}:${encode(this.config.clientSecret)}`).toString("base64")}`;
    if (entry.authorization !== expected || form.has("client_secret")) return json(401, { error: "invalid_client" });
    if (this.exchangeError) return json(400, { error: this.exchangeError, error_description: `${this.config.clientSecret} ${form.get("subject_token")}` });
    if (form.get("audience") !== this.config.exchangeAudience) return json(400, { error: "invalid_target" });
    const subjectToken = form.get("subject_token")!;
    if (this.revoked.has(subjectToken)) return json(400, { error: "invalid_grant" });
    const subject = decodeJwt(subjectToken);
    const exp = Math.min(Date.now() / 1000 + this.exchangeTtl, subject.exp!);
    const scope = form.get("scope") ?? subject.scope;
    const claims = { iss: "https://issuer.example.com", aud: this.config.exchangeAudience, sub: subject.sub, exp,
      scope, act: { sub: this.config.clientId }, jti: randomUUID(), ...this.exchangedClaims };
    const token = await new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: "api-key" }).sign(this.apiKeys.privateKey);
    entry.token = token;
    this.api.providerTokens.set(token, { accessToken: token, address: subject.sub!, expiresAtMs: exp * 1000 });
    return json(200, { access_token: token, issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer", expires_in: exp - Date.now() / 1000, scope, ...this.responseOverride });
  }
}
