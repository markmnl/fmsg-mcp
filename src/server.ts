import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import type { CallerProvider } from "./context.js";
import { buildInstructions } from "./instructions.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import type { ToolDeps } from "./tools/common.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerListTools } from "./tools/list.js";
import { registerReadTools } from "./tools/read.js";
import { registerSendTools } from "./tools/send.js";
import { registerWaitTools } from "./tools/wait.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "fmsg";

export type CreateServerOptions = {
  /** The caller's address when already known; makes the instructions name it. */
  address?: string;
};

/**
 * Build an fmsg MCP server. Registration only — no I/O — so the same factory
 * serves one stdio connection or one HTTP request.
 */
export function createFmsgMcpServer(provider: CallerProvider, config: Config, options: CreateServerOptions = {}): McpServer {
  const instructions = buildInstructions({
    ...(options.address ? { address: options.address } : {}),
    ...(config.defaultDomain ? { defaultDomain: config.defaultDomain } : {}),
  });
  const server = new McpServer({ name: SERVER_NAME, title: "fmsg", version: VERSION }, { instructions });
  const deps: ToolDeps = { provider, config };
  registerIdentityTools(server, deps);
  registerListTools(server, deps);
  registerReadTools(server, deps);
  registerSendTools(server, deps);
  registerWaitTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server);
  return server;
}
