import type { HostTransport } from "./host-files.js";
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
import { registerSearchTool } from "./tools/search.js";
import type { SearchSupportCache } from "./search-support.js";
import { VERSION } from "./version.js";
import type { PresignedLinks } from "./links.js";
import { IndicatorRegistry } from "./indicators.js";

export const SERVER_NAME = "fmsg";

export type CreateServerOptions = {
  /** The caller's address when already known; makes the instructions name it. */
  address?: string;
  /** The address that owns the caller's sub-address, when known; the instructions and descriptions then name it. */
  owner?: string;
  /** Aborted when the process begins shutting down, so wait_for_message returns "interrupted". */
  shutdown?: AbortSignal;
  /** Issues presigned download and upload links (HTTP with a public URL). */
  links?: PresignedLinks;
  /**
   * Indicators set with the indicate tool and kept up on the caller's behalf (FMSG-006). A factory that builds one
   * server per HTTP request must pass a shared registry and close it on shutdown. Without one, the server owns its own
   * and clears every indicator when it closes or `shutdown` aborts, which suits a server that lives for a whole session
   * (stdio).
   */
  indicators?: IndicatorRegistry;
  /** Fetches files given by reference (tests substitute it). */
  hostTransport?: HostTransport;
  /**
   * List search_messages: the Web API implements the optional GET /fmsg/search. The transports find this out before
   * building the server (see searchAvailable), so the factory itself stays free of I/O.
   */
  search?: boolean;
  /** Where search_messages records that a host refused search (tests substitute it). */
  searchSupport?: SearchSupportCache;
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
    files: fileRoutes(config, Boolean(options.links)),
    search: options.search === true,
  });
  const server = new McpServer({ name: SERVER_NAME, title: "fmsg", version: VERSION }, { instructions });
  const includeOwner = includeOwnerSchema(options.address, options.owner);
  let indicators = options.indicators;
  if (!indicators) {
    const owned = new IndicatorRegistry();
    indicators = owned;
    const previous = server.server.onclose;
    server.server.onclose = () => { owned.close(); previous?.(); };
    options.shutdown?.addEventListener("abort", () => owned.close(), { once: true });
    if (options.shutdown?.aborted) owned.close();
  }
  const deps: ToolDeps = {
    provider, config, ...(includeOwner ? { includeOwner } : {}), ...(options.shutdown ? { shutdown: options.shutdown } : {}),
    ...(options.links ? { links: options.links } : {}), indicators,
    ...(options.hostTransport ? { hostTransport: options.hostTransport } : {}),
  };
  registerIdentityTools(server, deps);
  registerListTools(server, deps);
  registerReadTools(server, deps);
  registerSaveTool(server, deps);
  registerDownloadTool(server, deps);
  registerSendTools(server, deps);
  registerDraftTools(server, deps);
  registerWaitTools(server, deps);
  if (options.search) registerSearchTool(options.searchSupport)(server, deps);
  registerResources(server, deps);
  registerPrompts(server, fileRoutes(config, Boolean(options.links)));
  return server;
}
