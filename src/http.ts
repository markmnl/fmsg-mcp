import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  originValidationResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { ApiKeyCallerProvider, FMSG_SCOPE } from "./auth.js";
import type { Config } from "./config.js";
import { createFmsgMcpServer } from "./server.js";
import { VERSION } from "./version.js";

export const MCP_PATH = "/mcp";

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Convert a Node request into a web-standard Request for the MCP handler. */
export function toWebRequest(req: IncomingMessage): Request {
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
      if (done) break;
      if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  } finally {
    res.off("close", abort);
    res.end();
  }
}

export type HttpServerHandle = { server: Server; close: () => Promise<void>; provider: ApiKeyCallerProvider };

export function createHttpServer(config: Config, log: (line: string) => void = (l) => console.error(l)): HttpServerHandle {
  const provider = new ApiKeyCallerProvider(config, log);
  const handler = createMcpHandler(() => createFmsgMcpServer(provider, config));
  const gate = requireBearerAuth({ verifier: provider, requiredScopes: [FMSG_SCOPE] });

  const allowedHosts = config.http.allowedHosts.length
    ? config.http.allowedHosts
    : isLoopback(config.http.host)
      ? localhostAllowedHostnames()
      : [];
  const allowedOrigins = config.http.allowedOrigins.length ? config.http.allowedOrigins : allowedHosts;
  if (!allowedHosts.length) log("warning: bound to a non-loopback address with no FMSG_MCP_ALLOWED_HOSTS; Host header is not validated");

  const server = createServer((req, res) => {
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
      const request = toWebRequest(req);
      if (allowedHosts.length) {
        const rejected = hostHeaderValidationResponse(request, allowedHosts) ?? originValidationResponse(request, allowedOrigins);
        if (rejected) return sendWebResponse(res, rejected);
      }
      const auth = await gate(request);
      if (auth instanceof Response) return sendWebResponse(res, auth);
      return sendWebResponse(res, await handler.fetch(request, { authInfo: auth }));
    })().catch((error) => {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    });
  });
  // Long-poll tools (wait_for_message) hold a request open for minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  const close = async () => {
    await handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, close, provider };
}
