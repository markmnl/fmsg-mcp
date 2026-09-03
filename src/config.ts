import { readFileSync } from "node:fs";
import { normalizeFmsgAddress } from "./address.js";

export type Transport = "stdio" | "http";

export type HttpConfig = {
  host: string;
  port: number;
  /** Hostnames accepted in the Host header. Empty means: derive from the bind address (loopback only). */
  allowedHosts: string[];
  /** Origins (hostnames) accepted in the Origin header for browser callers; empty = same as allowedHosts. */
  allowedOrigins: string[];
  keyCacheMax: number;
  keyCacheTtlMs: number;
};

export type Config = {
  transport: Transport;
  apiUrl: string;
  /** Only set in stdio mode. */
  apiKey?: string;
  defaultDomain?: string;
  directory?: Record<string, string>;
  /** Hard cap on a single wait_for_message call. */
  waitMaxSeconds: number;
  /** Directory attachments may be saved under (stdio only); unset = anywhere. */
  downloadDir?: string;
  http: HttpConfig;
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

export function loadConfig(env: NodeJS.ProcessEnv, transport: Transport, overrides: ConfigOverrides = {}): Config {
  const apiUrl = env.FMSG_API_URL?.trim();
  if (!apiUrl) throw new Error("FMSG_API_URL is required (base URL of the fmsg Web API, e.g. https://api.example.com)");
  if (!/^https?:\/\//u.test(apiUrl)) throw new Error("FMSG_API_URL must start with http:// or https://");

  const apiKey = env.FMSG_API_KEY?.trim();
  if (transport === "stdio" && !apiKey) {
    throw new Error("FMSG_API_KEY is required in stdio mode (an fmsgk_... key for the address this server sends as)");
  }
  if (transport === "http" && apiKey) {
    throw new Error(
      "FMSG_API_KEY must not be set in HTTP mode: each client supplies its own key as `Authorization: Bearer fmsgk_...`",
    );
  }

  const defaultDomain = env.FMSG_DEFAULT_DOMAIN?.trim().replace(/^@/u, "") || undefined;
  const directoryPath = env.FMSG_DIRECTORY?.trim();

  const port = overrides.port ?? intEnv(env, "FMSG_MCP_PORT", DEFAULT_HTTP_PORT, 0);
  const host = overrides.host ?? env.FMSG_MCP_HOST?.trim() ?? "127.0.0.1";

  return {
    transport,
    apiUrl: apiUrl.replace(/\/+$/u, ""),
    ...(transport === "stdio" && apiKey ? { apiKey } : {}),
    ...(defaultDomain ? { defaultDomain } : {}),
    ...(directoryPath ? { directory: loadDirectory(directoryPath) } : {}),
    waitMaxSeconds: intEnv(env, "FMSG_MCP_WAIT_MAX_SECONDS", DEFAULT_WAIT_MAX_SECONDS),
    ...(env.FMSG_MCP_DOWNLOAD_DIR?.trim() ? { downloadDir: env.FMSG_MCP_DOWNLOAD_DIR.trim() } : {}),
    http: {
      host,
      port,
      allowedHosts: listEnv(env, "FMSG_MCP_ALLOWED_HOSTS"),
      allowedOrigins: listEnv(env, "FMSG_MCP_ALLOWED_ORIGINS"),
      keyCacheMax: intEnv(env, "FMSG_MCP_KEY_CACHE_MAX", 500),
      keyCacheTtlMs: intEnv(env, "FMSG_MCP_KEY_CACHE_TTL_SECONDS", 1800) * 1000,
    },
  };
}
