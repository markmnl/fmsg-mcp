import * as z from "zod/v4";
import { type AddressResolver, CALLER_DOMAIN, effectiveDefaultDomain, resolveAddress } from "../address.js";
import { isoTime } from "../render.js";
import { READ_ONLY, type Register, ok, resolverFor, withCaller } from "./common.js";
import { toolError } from "../errors.js";
import type { Transport } from "../config.js";

const TRANSPORT_NAMES: Record<Transport, { id: "stdio" | "streamable-http"; label: string }> = {
  stdio: { id: "stdio", label: "stdio" },
  http: { id: "streamable-http", label: "Streamable HTTP" },
};

export const registerIdentityTools: Register = (server, deps) => {
  server.registerTool(
    "whoami",
    {
      title: "Show fmsg identity",
      description:
        "Report the fmsg address this server acts as (from the authenticated connection), the fmsg Web API URL " +
        "(null when the server does not publish it), the MCP transport and the address-resolution defaults. " +
        "Access is renewed automatically; no action is needed. Call this first if unsure who you are sending as.",
      outputSchema: z.object({
        address: z.string(),
        api_url: z.string().nullable(),
        token_expires_at: z.string().nullable().describe(
          "internal: when the server's current upstream access token expires; it is renewed automatically, so no action is needed",
        ),
        transport: z.enum(["stdio", "streamable-http"]),
        default_domain: z.string().nullable(),
        directory_names: z.array(z.string()).optional().describe("short names in the operator-configured directory; omitted when there are none"),
      }),
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async (ctx) =>
      withCaller(deps, ctx, async (caller) => {
        const expires = isoTime((await caller.tokenExpiresAt()) / 1000);
        const defaultDomain = effectiveDefaultDomain(deps.config.defaultDomain, caller.address);
        const directoryNames = Object.keys(deps.config.directory ?? {});
        const transport = TRANSPORT_NAMES[deps.config.transport];
        const structured = {
          address: caller.address,
          api_url: deps.config.apiPublicUrl ?? null,
          token_expires_at: expires,
          transport: transport.id,
          default_domain: defaultDomain ?? null,
          ...(directoryNames.length ? { directory_names: directoryNames } : {}),
        };
        const lines = [
          deps.config.apiPublicUrl
            ? `You are **${caller.address}** on ${deps.config.apiPublicUrl}, connected over ${transport.label}.`
            : `You are **${caller.address}**, connected over ${transport.label}.`,
          "Access is renewed automatically.",
        ];
        if (defaultDomain) lines.push(`Short names resolve to @name@${defaultDomain}.`);
        if (directoryNames.length) lines.push(`Directory names: ${directoryNames.join(", ")}.`);
        return ok(lines.join("\n"), structured);
      }),
  );

  // Describe only the resolution steps this deployment has; both are operator settings.
  const steps = [
    ...(Object.keys(deps.config.directory ?? {}).length ? ["otherwise an entry in the operator-configured directory of short names"] : []),
    ...(deps.config.defaultDomain === CALLER_DOMAIN ? ["otherwise @name@<your domain>, the domain of the address you act as"]
      : deps.config.defaultDomain ? [`otherwise @name@${deps.config.defaultDomain}`] : []),
  ];
  server.registerTool(
    "resolve_address",
    {
      title: "Resolve fmsg address",
      description:
        "Resolve a recipient to a full fmsg address without sending anything: a literal @user@domain is returned " +
        `as-is${steps.length ? `, ${steps.join(", ")}` : "; this server has no short-name defaults, so other names fail"}. ` +
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
