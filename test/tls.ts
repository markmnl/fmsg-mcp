/**
 * A throwaway TLS front for tests: a self-signed certificate for 127.0.0.1 made with openssl at run time (so no key
 * is committed), and an HTTPS server that forwards every request to a plain HTTP server, like the reverse proxy in
 * front of a deployment.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, request as httpsRequest, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

export type Certificate = { key: string; cert: string };

export function hasOpenssl(): boolean {
  try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

export function selfSignedCertificate(): Certificate {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fmsg-mcp-tls-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
      "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ], { stdio: "ignore" });
    return { key: readFileSync(path.join(dir, "key.pem"), "utf8"), cert: readFileSync(path.join(dir, "cert.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An HTTPS proxy to `http://127.0.0.1:{upstreamPort()}`; the port is read per request so it can be set after start. */
export async function tlsProxy(certificate: Certificate, upstreamPort: () => number): Promise<{ server: Server; origin: string; close: () => Promise<void> }> {
  const server = createServer(certificate, (req, res) => {
    const upstream = httpRequest({ host: "127.0.0.1", port: upstreamPort(), method: req.method, path: req.url, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      // An upstream response cut off part-way is cut off here too, as a proxy would.
      response.on("aborted", () => res.destroy());
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    origin: `https://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export type HttpsResult = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

/** One HTTPS request trusting `ca`, with exactly the headers given (no Authorization unless passed). */
export function httpsFetch(ca: string, method: string, url: string, headers: Record<string, string> = {}, body?: Uint8Array): Promise<HttpsResult> {
  return new Promise<HttpsResult>((resolve, reject) => {
    const req = httpsRequest(new URL(url), { method, headers, ca }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("response aborted")));
    });
    req.on("error", reject);
    req.end(body ? Buffer.from(body) : undefined);
  });
}
