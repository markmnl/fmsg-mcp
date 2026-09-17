import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { ApiKeyCallerProvider, FMSG_SCOPE } from "./auth.js";
import type { Config } from "./config.js";
import { createFmsgMcpServer } from "./server.js";
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
export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = name.toLowerCase() === "set-cookie" ? [...(headers[name] ?? []), value] : value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  res.on("close", abort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
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

export type HttpServerHandle = { server: Server; close: () => Promise<void>; provider: ApiKeyCallerProvider };

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
  const provider = new ApiKeyCallerProvider(config, safeLog);
  const handler = createMcpHandler(({ authInfo }) =>
    createFmsgMcpServer(provider, config, authInfo?.clientId ? { address: authInfo.clientId } : {}),
    { onerror: (error) => safeLog(`MCP transport failed: ${safeErrorMessage(error)}`) },
  );
  const gate = requireBearerAuth({ verifier: provider, requiredScopes: [FMSG_SCOPE] });
  const active = new Set<AbortController>();

  const server = createServer((req, res) => {
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
          valid = new URL(origin).origin === origin &&
            (allowedOrigins.includes(origin) || origin === new URL(request.url).origin);
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
      const auth = await gate(request);
      if (auth instanceof Response) return sendWebResponse(res, auth);
      return sendWebResponse(res, await handler.fetch(request, { authInfo: auth }));
    })().catch((error) => {
      safeLog(`request failed: ${safeErrorMessage(error)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    }).finally(() => {
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
