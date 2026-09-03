import * as z from "zod/v4";
import { resolveAddress } from "../address.js";
import { isoTime } from "../render.js";
import { READ_ONLY, type Register, ok, withCaller } from "./common.js";
import { toolError } from "../errors.js";

export const registerIdentityTools: Register = (server, deps) => {
  server.registerTool(
    "whoami",
    {
      title: "Show fmsg identity",
      description:
        "Report the fmsg address this server acts as (derived from the API key), the fmsg Web API URL, " +
        "when the current access token expires (it is renewed automatically; no action needed), and the " +
        "address-resolution defaults. Call this first if unsure who you are sending as.",
      outputSchema: z.object({
        address: z.string(),
        api_url: z.string(),
        token_expires_at: z.string().nullable(),
        transport: z.enum(["stdio", "http"]),
        default_domain: z.string().nullable(),
        directory_names: z.array(z.string()),
      }),
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async (ctx) =>
      withCaller(deps, ctx, async (caller) => {
        const expires = isoTime((await caller.tokenExpiresAt()) / 1000);
        const structured = {
          address: caller.address,
          api_url: caller.client.apiUrl,
          token_expires_at: expires,
          transport: deps.config.transport,
          default_domain: deps.config.defaultDomain ?? null,
          directory_names: Object.keys(deps.config.directory ?? {}),
        };
        const lines = [
          `You are **${caller.address}** on ${caller.client.apiUrl} (${deps.config.transport}).`,
          `Access token expires ${expires ?? "unknown"} and is renewed automatically.`,
        ];
        if (deps.config.defaultDomain) lines.push(`Short names resolve to @name@${deps.config.defaultDomain}.`);
        if (structured.directory_names.length) lines.push(`Directory names: ${structured.directory_names.join(", ")}.`);
        return ok(lines.join("\n"), structured);
      }),
  );

  server.registerTool(
    "resolve_address",
    {
      title: "Resolve fmsg address",
      description:
        "Resolve a short name to a full fmsg address without sending anything: a literal @user@domain is returned " +
        "as-is, otherwise a configured directory entry is used, otherwise @name@<default domain>. " +
        "Fails when nothing matches so you can ask the user for the full address.",
      inputSchema: z.object({ name: z.string().describe("Full fmsg address (@user@domain) or a short name") }),
      outputSchema: z.object({ address: z.string(), resolution: z.enum(["literal", "directory", "default_domain"]) }),
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async ({ name }) => {
      try {
        const resolved = resolveAddress(name, deps.config);
        return ok(`${name} → ${resolved.address} (${resolved.resolution})`, resolved);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  );
};
