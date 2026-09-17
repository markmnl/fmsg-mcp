/** Hosts for which cleartext loopback development is safe by default. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function normalizeApiUrl(value: string, allowInsecureHttp = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FMSG_API_URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("FMSG_API_URL must be an http(s) URL");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("FMSG_API_URL must not contain credentials, a query string or a fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !allowInsecureHttp) {
    throw new Error("FMSG_API_URL must use HTTPS outside loopback; explicitly enable FMSG_ALLOW_INSECURE_HTTP=1 only for a trusted development/private network");
  }
  return url.href.replace(/\/+$/u, "");
}

export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FMSG_MCP_ALLOWED_ORIGINS entries must be complete http(s) origins, e.g. https://example.com");
  }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("FMSG_MCP_ALLOWED_ORIGINS entries must be complete http(s) origins without credentials, paths, queries or fragments");
  }
  return url.origin;
}
