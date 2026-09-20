import { readFileSync } from "node:fs";
import { normalizeFmsgAddress } from "./address.js";
import { normalizeApiUrl, normalizeOrigin } from "./client/url.js";
import { loadOAuthConfig, oauthUrl, type OAuthConfig } from "./oauth/config.js";

export type Transport = "stdio" | "http";

export type HttpConfig = {
  host: string;
  port: number;
  /** Canonical public MCP endpoint for credential-free attachment links. */
  publicUrl?: string;
  /** Hostnames accepted in the Host header. Empty means: derive from the bind address (loopback only). */
  allowedHosts: string[];
  /** Exact browser origins. Empty permits same-origin and, on loopback binds, loopback origins on any port. */
  allowedOrigins: string[];
  keyCacheMax: number;
  keyCacheTtlMs: number;
};

export type Config = {
  transport: Transport;
  apiUrl: string;
  /** Explicit opt-in for cleartext upstream traffic outside loopback. */
  allowInsecureHttp?: boolean;
  /** Only set in stdio mode. */
  apiKey?: string;
  defaultDomain?: string;
  directory?: Record<string, string>;
  /** Trusted local destination; enables save_attachment over stdio only. */
  downloadDir?: string;
  /** Hard cap on a single wait_for_message call. */
  waitMaxSeconds: number;
  http: HttpConfig;
  oauth?: OAuthConfig;
};

export const DEFAULT_HTTP_PORT = 8765;
export const DEFAULT_WAIT_MAX_SECONDS = 230;

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

function listEnv(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadDirectory(path: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`FMSG_DIRECTORY ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`FMSG_DIRECTORY ${path}: expected a JSON object of short name -> @user@domain`);
  }
  const out: Record<string, string> = {};
  for (const [name, target] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof target !== "string" || !normalizeFmsgAddress(target)) {
      throw new Error(`FMSG_DIRECTORY ${path}: entry "${name}" is not an fmsg address`);
    }
    out[name] = normalizeFmsgAddress(target)!;
  }
  return out;
}

export type ConfigOverrides = { host?: string; port?: number };

export type LoadConfigOptions = {
  /**
   * stdio only: when false, a missing FMSG_API_URL / FMSG_API_KEY does not throw and
   * `apiUrl` is left empty, so the server can still start and answer introspection
   * (tools/list etc.). Tools then fail with a configuration hint when called.
   */
  requireCredentials?: boolean;
};

export function loadConfig(
  env: NodeJS.ProcessEnv,
  transport: Transport,
  overrides: ConfigOverrides = {},
  options: LoadConfigOptions = {},
): Config {
  const requireCredentials = options.requireCredentials ?? true;
  const oauth = loadOAuthConfig(env, transport);
  const apiUrl = env.FMSG_API_URL?.trim() ?? "";
  if (!apiUrl && (transport === "http" || requireCredentials)) {
    throw new Error("FMSG_API_URL is required (base URL of the fmsg Web API, e.g. https://api.example.com)");
  }
  const allowInsecureHttp = env.FMSG_ALLOW_INSECURE_HTTP === "1";
  const normalizedApiUrl = apiUrl ? normalizeApiUrl(apiUrl, allowInsecureHttp) : "";

  const apiKey = env.FMSG_API_KEY?.trim();
  if (transport === "stdio" && apiKey && !apiKey.startsWith("fmsgk_")) throw new Error("FMSG_API_KEY must start with fmsgk_");
  if (transport === "stdio" && !apiKey && requireCredentials) {
    throw new Error("FMSG_API_KEY is required in stdio mode (an fmsgk_... key for the address this server sends as)");
  }
  if (transport === "http" && apiKey) {
    throw new Error(
      "FMSG_API_KEY must not be set in HTTP mode: each client supplies its own bearer credential",
    );
  }

  const defaultDomain = env.FMSG_DEFAULT_DOMAIN?.trim().replace(/^@/u, "") || undefined;
  const directoryPath = env.FMSG_DIRECTORY?.trim();

  const port = overrides.port ?? intEnv(env, "FMSG_MCP_PORT", DEFAULT_HTTP_PORT, 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("FMSG_MCP_PORT must be between 0 and 65535");
  const host = overrides.host ?? env.FMSG_MCP_HOST?.trim() ?? "127.0.0.1";
  const publicUrl = transport === "http" ? env.FMSG_MCP_PUBLIC_URL?.trim() || oauth?.resourceUrl : undefined;
  if (publicUrl) oauthUrl(publicUrl, "FMSG_MCP_PUBLIC_URL");
  if (oauth && publicUrl !== oauth.resourceUrl) throw new Error("FMSG_MCP_PUBLIC_URL must match FMSG_MCP_OAUTH_RESOURCE_URL in OAuth mode");

  return {
    transport,
    apiUrl: normalizedApiUrl,
    ...(oauth ? { oauth } : {}),
    allowInsecureHttp,
    ...(transport === "stdio" && apiKey ? { apiKey } : {}),
    ...(defaultDomain ? { defaultDomain } : {}),
    ...(directoryPath ? { directory: loadDirectory(directoryPath) } : {}),
    ...(transport === "stdio" && env.FMSG_MCP_DOWNLOAD_DIR?.trim() ? { downloadDir: env.FMSG_MCP_DOWNLOAD_DIR.trim() } : {}),
    waitMaxSeconds: intEnv(env, "FMSG_MCP_WAIT_MAX_SECONDS", DEFAULT_WAIT_MAX_SECONDS),
    http: {
      host,
      port,
      ...(publicUrl ? { publicUrl } : {}),
      allowedHosts: listEnv(env, "FMSG_MCP_ALLOWED_HOSTS"),
      allowedOrigins: listEnv(env, "FMSG_MCP_ALLOWED_ORIGINS").map(normalizeOrigin),
      keyCacheMax: intEnv(env, "FMSG_MCP_KEY_CACHE_MAX", 500),
      keyCacheTtlMs: intEnv(env, "FMSG_MCP_KEY_CACHE_TTL_SECONDS", 1800) * 1000,
    },
  };
}
