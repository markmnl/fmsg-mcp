import * as z from "zod/v4";
import { type AddressResolver, CALLER_DOMAIN, effectiveDefaultDomain, resolveAddress } from "../address.js";
import { isoTime } from "../render.js";
import { READ_ONLY, type Register, ok, resolverFor, withCaller } from "./common.js";
import { toolError } from "../errors.js";

export const registerIdentityTools: Register = (server, deps) => {
  server.registerTool(
    "whoami",
    {
      title: "Show fmsg identity",
      description:
        "Report the fmsg address this server acts as (from the authenticated connection), the fmsg Web API URL " +
        "(null when the server does not publish it), " +
        "when the current access token expires (it is renewed automatically; no action needed), and the " +
        "address-resolution defaults. Call this first if unsure who you are sending as.",
      outputSchema: z.object({
        address: z.string(),
        api_url: z.string().nullable(),
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
        const defaultDomain = effectiveDefaultDomain(deps.config.defaultDomain, caller.address);
        const structured = {
          address: caller.address,
          api_url: deps.config.apiPublicUrl ?? null,
          token_expires_at: expires,
          transport: deps.config.transport,
          default_domain: defaultDomain ?? null,
          directory_names: Object.keys(deps.config.directory ?? {}),
        };
        const lines = [
          deps.config.apiPublicUrl
            ? `You are **${caller.address}** on ${deps.config.apiPublicUrl} (${deps.config.transport}).`
            : `You are **${caller.address}** (${deps.config.transport}).`,
          `Access token expires ${expires ?? "unknown"} and is renewed automatically.`,
        ];
        if (defaultDomain) lines.push(`Short names resolve to @name@${defaultDomain}.`);
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
    async ({ name }, ctx) => {
      const resolve = (resolver: AddressResolver) => {
        try {
          const resolved = resolveAddress(name, resolver);
          return ok(`${name} → ${resolved.address} (${resolved.resolution})`, resolved);
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error));
        }
      };
      // Only the caller's own domain needs the caller; otherwise resolution is local.
      if (deps.config.defaultDomain !== CALLER_DOMAIN) return resolve(deps.config);
      return withCaller(deps, ctx, async (caller) => resolve(resolverFor(deps, caller)));
    },
  );
};
