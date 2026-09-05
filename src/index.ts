#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { FmsgClient } from "./client/client.js";
import { loadConfig, DEFAULT_HTTP_PORT, type ConfigOverrides } from "./config.js";
import { type CallerProvider, StaticCallerProvider, UnconfiguredCallerProvider } from "./context.js";
import { createHttpServer, MCP_PATH } from "./http.js";
import { createFmsgMcpServer } from "./server.js";
import { PACKAGE_NAME, VERSION } from "./version.js";

const USAGE = `${PACKAGE_NAME} ${VERSION} — MCP server for fmsg

Usage:
  fmsg-mcp                      serve MCP over stdio (FMSG_API_URL + FMSG_API_KEY)
  fmsg-mcp --http [host:port]   serve Streamable HTTP at /mcp; clients send their own
                                fmsg API key as "Authorization: Bearer fmsgk_..."
  fmsg-mcp --version | --help

Options (HTTP mode):
  --host <host>   bind address (default 127.0.0.1, or FMSG_MCP_HOST)
  --port <port>   port (default ${DEFAULT_HTTP_PORT}, or FMSG_MCP_PORT)

Environment:
  FMSG_API_URL               base URL of the fmsg Web API (required)
  FMSG_API_KEY               fmsgk_... key (stdio mode only)
  FMSG_DEFAULT_DOMAIN        lets short names resolve: bob -> @bob@<domain>
  FMSG_DIRECTORY             JSON file mapping short names to @user@domain
  FMSG_MCP_WAIT_MAX_SECONDS  cap on one wait_for_message call (default 230)
  FMSG_MCP_DOWNLOAD_DIR      restrict download_attachment save_to (stdio)
  FMSG_MCP_ALLOWED_HOSTS     comma-separated Host header allowlist (HTTP, non-loopback)
`;

type Args = { mode: "stdio" | "http" | "version" | "help"; overrides: ConfigOverrides };

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "stdio", overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--version" || a === "-v") args.mode = "version";
    else if (a === "--help" || a === "-h") args.mode = "help";
    else if (a === "--stdio") args.mode = "stdio";
    else if (a === "--http") {
      args.mode = "http";
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        i++;
        const m = /^(?:\[?([^\]]*)\]?:)?(\d+)$/u.exec(next);
        if (!m) throw new Error(`invalid --http address "${next}" (expected host:port or port)`);
        if (m[1]) args.overrides.host = m[1];
        args.overrides.port = Number(m[2]);
      }
    } else if (a === "--host") {
      const v = argv[++i];
      if (!v) throw new Error("--host requires a value");
      args.overrides.host = v;
    } else if (a === "--port") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error("--port requires a port number");
      args.overrides.port = v;
    } else throw new Error(`unknown argument "${a}" (see --help)`);
  }
  return args;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (args.mode === "version") {
    console.log(VERSION);
    return;
  }
  if (args.mode === "help") {
    console.log(USAGE);
    return;
  }
  const transport = args.mode;
  let config;
  try {
    config = loadConfig(process.env, transport, args.overrides, { requireCredentials: false });
  } catch (error) {
    console.error(`fmsg-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  if (transport === "stdio") {
    const cfg = config;
    let provider: CallerProvider;
    if (cfg.apiUrl && cfg.apiKey) {
      provider = new StaticCallerProvider(new FmsgClient(cfg.apiUrl, cfg.apiKey));
      console.error(`fmsg-mcp ${VERSION} serving stdio for ${cfg.apiUrl}`);
    } else {
      const missing = [!cfg.apiUrl && "FMSG_API_URL", !cfg.apiKey && "FMSG_API_KEY"].filter(Boolean).join(" and ");
      const reason = `fmsg-mcp is not configured: set ${missing} (the fmsg Web API base URL and an fmsgk_... API key for the address this server sends as)`;
      provider = new UnconfiguredCallerProvider(reason);
      console.error(`fmsg-mcp ${VERSION} serving stdio WITHOUT credentials (${missing} not set): tools are listed but every call will fail until configured`);
    }
    // Resolve the address once so the instructions can name it; never let a slow
    // or unreachable host hold up initialize.
    const knownAddress = async (): Promise<string | undefined> => {
      if (!cfg.apiUrl || !cfg.apiKey) return undefined;
      const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000).unref());
      return Promise.race([provider.forRequest(undefined).then((c) => c.address), timeout]).catch(() => undefined);
    };
    const handle = serveStdio(async () => {
      const address = await knownAddress();
      return createFmsgMcpServer(provider, cfg, address ? { address } : {});
    });
    const stop = () => void handle.close().finally(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  const { server, close } = createHttpServer(config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.http.port, config.http.host, () => resolve());
  });
  const addr = server.address();
  const shown = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : `${config.http.host}:${config.http.port}`;
  console.error(`fmsg-mcp ${VERSION} serving Streamable HTTP at http://${shown}${MCP_PATH} for ${config.apiUrl}`);
  const stop = () => void close().finally(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly() || process.env.FMSG_MCP_MAIN === "1") {
  main().catch((error) => {
    console.error(`fmsg-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
