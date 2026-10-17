import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import type { CallerProvider } from "./context.js";
import { buildInstructions } from "./instructions.js";
import { includeOwnerSchema } from "./owner.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { fileRoutes } from "./tools/attachments.js";
import type { ToolDeps } from "./tools/common.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerListTools } from "./tools/list.js";
import { registerReadTools } from "./tools/read.js";
import { registerSendTools } from "./tools/send.js";
import { registerDraftTools } from "./tools/draft.js";
import { registerWaitTools } from "./tools/wait.js";
import { registerSaveTool } from "./tools/save.js";
import { registerDownloadTool } from "./tools/download.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "fmsg";

export type CreateServerOptions = {
  /** The caller's address when already known; makes the instructions name it. */
  address?: string;
  /** The address that owns the caller's sub-address, when known; the instructions and descriptions then name it. */
  owner?: string;
  /** Aborted when the process begins shutting down, so wait_for_message returns "interrupted". */
  shutdown?: AbortSignal;
};

/**
 * Build an fmsg MCP server. Registration only — no I/O — so the same factory
 * serves one stdio connection or one HTTP request.
 */
export function createFmsgMcpServer(provider: CallerProvider, config: Config, options: CreateServerOptions = {}): McpServer {
  const instructions = buildInstructions({
    ...(options.address ? { address: options.address } : {}),
    ...(options.owner ? { owner: options.owner } : {}),
    ...(config.defaultDomain ? { defaultDomain: config.defaultDomain } : {}),
    files: fileRoutes(config),
  });
  const server = new McpServer({ name: SERVER_NAME, title: "fmsg", version: VERSION }, { instructions });
  const includeOwner = includeOwnerSchema(options.address, options.owner);
  const deps: ToolDeps = {
    provider, config, ...(includeOwner ? { includeOwner } : {}), ...(options.shutdown ? { shutdown: options.shutdown } : {}),
  };
  registerIdentityTools(server, deps);
  registerListTools(server, deps);
  registerReadTools(server, deps);
  registerSaveTool(server, deps);
  registerDownloadTool(server, deps);
  registerSendTools(server, deps);
  registerDraftTools(server, deps);
  registerWaitTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server, fileRoutes(config));
  return server;
}
