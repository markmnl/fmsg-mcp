import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  type AuthInfo,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { ApiKeyCallerProvider, FMSG_SCOPE } from "./auth.js";
import type { Config } from "./config.js";
import { createFmsgMcpServer } from "./server.js";
import { OAuthCallerProvider } from "./oauth/provider.js";
import { invalidToken, insufficientScope, OAuthRequestError, oauthErrorResponse, oauthRequestState, type OAuthRequestState } from "./oauth/errors.js";
import { MESSAGING_SCOPES, requestScopes } from "./oauth/scopes.js";
import { VERSION } from "./version.js";
import { safeErrorMessage } from "./client/redact.js";
import { isLoopbackHost, normalizeOrigin } from "./client/url.js";

export const MCP_PATH = "/mcp";

const CORS_METHODS = ["POST", "GET", "DELETE"];
const CORS_HEADERS = ["authorization", "content-type", "accept", "mcp-protocol-version", "mcp-method", "mcp-name", "mcp-session-id", "last-event-id"];

/** Convert a Node request into a web-standard Request for the MCP handler. */
export function toWebRequest(req: IncomingMessage, signal?: AbortSignal): Request {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: "half" } : {}),
  } as RequestInit);
}

/** Pipe a web-standard Response (possibly a long SSE stream) to the Node response. */
export async function sendWebResponse(res: ServerResponse, response: Response, failure?: () => Response | undefined): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = name.toLowerCase() === "set-cookie" ? [...(headers[name] ?? []), value] : value;
  });
  if (!response.body) {
    res.writeHead(response.status, headers);
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  res.on("close", abort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (!res.headersSent) {
        const rejected = failure?.();
        if (rejected) { await reader.cancel(); return await sendWebResponse(res, rejected); }
        res.writeHead(response.status, headers);
      }
      if (done || res.destroyed) break;
      if (!res.write(value)) await new Promise<void>((resolve) => {
        const finish = () => {
          res.off("drain", finish);
          res.off("close", finish);
          resolve();
        };
        res.once("drain", finish);
        res.once("close", finish);
        if (res.destroyed) finish();
      });
    }
  } finally {
    res.off("close", abort);
    await reader.cancel().catch(() => undefined);
    res.end();
  }
}

export type HttpServerHandle = { server: Server; close: () => Promise<void>; provider: ApiKeyCallerProvider | OAuthCallerProvider };

export function createHttpServer(config: Config, log: (line: string) => void = (l) => console.error(l)): HttpServerHandle {
  const allowedHosts = config.http.allowedHosts.length
    ? config.http.allowedHosts
    : isLoopbackHost(config.http.host)
      ? localhostAllowedHostnames()
      : [];
  if (!allowedHosts.length) throw new Error("FMSG_MCP_ALLOWED_HOSTS is required when binding HTTP to a non-loopback address");
  if (allowedHosts.some((host) => /[*\s/@?#]/u.test(host))) throw new Error("FMSG_MCP_ALLOWED_HOSTS must contain explicit hostnames without wildcards, schemes or paths");
  const allowedOrigins = config.http.allowedOrigins.map(normalizeOrigin);
  const safeLog = (line: string) => log(safeErrorMessage(line));
  const provider = config.oauth ? new OAuthCallerProvider(config, safeLog) : new ApiKeyCallerProvider(config, safeLog);
  const resource = config.oauth ? new URL(config.oauth.resourceUrl) : undefined;
  const metadataPath = resource ? `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}` : undefined;
  const metadataUrl = resource ? `${resource.origin}${metadataPath}` : "";
  const handler = createMcpHandler(({ authInfo }) =>
    createFmsgMcpServer(provider, config, authInfo ? {
      address: config.oauth ? String(authInfo.extra?.address ?? "") : authInfo.clientId,
    } : {}),
    { onerror: (error) => safeLog(`MCP transport failed: ${error instanceof Error ? error.message : String(error)}`) },
  );
  const active = new Set<AbortController>();

  const server = createServer((req, res) => {
    let authenticated: AuthInfo | undefined;
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: "fmsg-mcp", version: VERSION }));
        return;
      }
      if (resource && (url.pathname === metadataPath || url.pathname === "/.well-known/oauth-protected-resource")) {
        const request = toWebRequest(req, controller.signal);
        if (hostHeaderValidationResponse(request, allowedHosts)) return sendWebResponse(res, new Response("host not allowed", { status: 403 }));
        const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "cache-control": "public, max-age=300" };
        if (req.method === "OPTIONS") return sendWebResponse(res, new Response(null, { status: 204, headers }));
        if (req.method !== "GET") return sendWebResponse(res, new Response(null, { status: 405, headers: { ...headers, allow: "GET, OPTIONS" } }));
        return sendWebResponse(res, Response.json({ resource: config.oauth!.resourceUrl,
          authorization_servers: [config.oauth!.issuerUrl], scopes_supported: MESSAGING_SCOPES,
          bearer_methods_supported: ["header"], resource_name: "fmsg messaging",
        }, { headers }));
      }
      if (url.pathname !== MCP_PATH) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found; the MCP endpoint is /mcp");
        return;
      }
      const request = toWebRequest(req, controller.signal);
      const rejected = hostHeaderValidationResponse(request, allowedHosts);
      // SDK rejection details echo the Host header; keep arbitrary input out
      // of authentication-boundary error responses.
      if (rejected) return sendWebResponse(res, new Response("host not allowed", { status: 403 }));
      const origin = request.headers.get("origin");
      if (origin !== null) {
        let valid = false;
        try {
          const parsed = new URL(origin);
          const localDevelopment = isLoopbackHost(config.http.host) && !allowedOrigins.length &&
            /^https?:$/u.test(parsed.protocol) && isLoopbackHost(parsed.hostname);
          valid = parsed.origin === origin &&
            (localDevelopment || allowedOrigins.includes(origin) || origin === (resource?.origin ?? new URL(request.url).origin));
        } catch { /* malformed origins are rejected */ }
        if (!valid) return sendWebResponse(res, new Response("origin not allowed", { status: 403 }));
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("access-control-expose-headers", "WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version, Retry-After");
      }
      res.setHeader("vary", "Origin");
      res.setHeader("cache-control", "no-store");
      if (req.method === "OPTIONS") {
        const method = request.headers.get("access-control-request-method") ?? "";
        const headers = (request.headers.get("access-control-request-headers") ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
        if (!origin || !CORS_METHODS.includes(method) || headers.some((h) => !CORS_HEADERS.includes(h))) {
          return sendWebResponse(res, new Response("preflight not allowed", { status: 403 }));
        }
        res.setHeader("access-control-allow-methods", CORS_METHODS.join(", "));
        res.setHeader("access-control-allow-headers", CORS_HEADERS.join(", "));
        return sendWebResponse(res, new Response(null, { status: 204 }));
      }
      if (provider instanceof OAuthCallerProvider) {
        try {
          const bearer = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/iu.exec(request.headers.get("authorization") ?? "");
          if (!bearer) throw invalidToken();
          authenticated = await provider.verifyAccessToken(bearer[1]!);
          let parsedBody: unknown;
          if (request.method === "POST") {
            try { parsedBody = await request.json(); }
            catch { return sendWebResponse(res, new Response("invalid JSON request", { status: 400 })); }
            if (Array.isArray(parsedBody)) return sendWebResponse(res, new Response("MCP batch requests are not supported", { status: 400 }));
          }
          const scopes = requestScopes(parsedBody);
          if (scopes.some(scope => !authenticated!.scopes.includes(scope))) throw insufficientScope(scopes);
          // Discover/list operations only need the incoming JWT. Resolve an
          // exchanged credential before starting any protected tool response.
          if (scopes.length) {
            const caller = await provider.forRequest(authenticated);
            await caller.client.getToken(false, controller.signal);
          }
          const state: OAuthRequestState = { scopes };
          return await oauthRequestState.run(state, async () => {
            const response = await handler.fetch(request, { authInfo: authenticated, parsedBody });
            await sendWebResponse(res, response, () => state.error ? oauthErrorResponse(state.error, metadataUrl) : undefined);
          });
        } catch (error) {
          if (error instanceof OAuthRequestError) return sendWebResponse(res, oauthErrorResponse(error, metadataUrl));
          throw error;
        }
      }
      // Capture the lease before middleware's expiry/scope checks, so finally also
      // releases requests rejected after the upstream identity was verified.
      const gate = requireBearerAuth({
        verifier: { verifyAccessToken: async (token) => {
          authenticated = await provider.verifyAccessToken(token);
          return authenticated;
        } },
        requiredScopes: [FMSG_SCOPE],
      });
      const auth = await gate(request);
      if (auth instanceof Response) return sendWebResponse(res, auth);
      return sendWebResponse(res, await handler.fetch(request, { authInfo: auth }));
    })().catch((error) => {
      safeLog(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    }).finally(() => {
      if (authenticated) provider.release(authenticated);
      active.delete(controller);
      req.off("aborted", abort);
      res.off("close", abort);
    });
  });
  // This bounds receiving the request body, not the duration of a wait response.
  server.requestTimeout = 60_000;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  const close = async () => {
    for (const controller of active) controller.abort();
    provider.close();
    await handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, close, provider };
}
