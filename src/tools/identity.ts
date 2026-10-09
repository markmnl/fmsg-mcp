import * as z from "zod/v4";
import { type AddressResolver, CALLER_DOMAIN, effectiveDefaultDomain, resolveAddress } from "../address.js";
import { addressText, isoTime } from "../render.js";
import { READ_ONLY, type Register, ok, openEnum, outputObject, resolverFor, withCaller } from "./common.js";
import { toolError } from "../errors.js";
import type { Transport } from "../config.js";

/** Structured output keeps the transport ids published since 0.2.5; only the text uses the friendlier label. */
const TRANSPORT_LABELS: Record<Transport, string> = { stdio: "stdio", http: "Streamable HTTP" };

export const registerIdentityTools: Register = (server, deps) => {
  server.registerTool(
    "whoami",
    {
      title: "Show fmsg identity",
      description:
        "Report the fmsg address this server acts as (from the authenticated connection), the fmsg Web API URL " +
        "(null when the server does not publish it), the MCP transport and the address-resolution defaults. " +
        "Access is renewed automatically; no action is needed. Call this first if unsure who you are sending as.",
      outputSchema: outputObject({
        address: z.string(),
        api_url: z.string().nullable(),
        token_expires_at: z.string().nullable().describe(
          "internal: when the server's current upstream access token expires; it is renewed automatically, so no action is needed",
        ),
        transport: openEnum(["stdio", "http"], "http is Streamable HTTP"),
        default_domain: z.string().nullable(),
        directory_names: z.array(z.string()).describe("short names in the operator-configured directory; empty when there are none"),
      }),
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async (ctx) =>
      withCaller(deps, ctx, async (caller) => {
        const expires = isoTime((await caller.tokenExpiresAt()) / 1000);
        const defaultDomain = effectiveDefaultDomain(deps.config.defaultDomain, caller.address);
        const directoryNames = Object.keys(deps.config.directory ?? {});
        const transport = TRANSPORT_LABELS[deps.config.transport];
        const structured = {
          address: caller.address,
          api_url: deps.config.apiPublicUrl ?? null,
          token_expires_at: expires,
          transport: deps.config.transport,
          default_domain: defaultDomain ?? null,
          directory_names: directoryNames,
        };
        const lines = [
          deps.config.apiPublicUrl
            ? `You are ${addressText(caller.address)} on ${deps.config.apiPublicUrl}, connected over ${transport}.`
            : `You are ${addressText(caller.address)}, connected over ${transport}.`,
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
      outputSchema: outputObject({ address: z.string(), resolution: openEnum(["literal", "directory", "default_domain"]) }),
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async ({ name }, ctx) => {
      const resolve = (resolver: AddressResolver) => {
        try {
          const resolved = resolveAddress(name, resolver);
          return ok(`${name} → ${addressText(resolved.address)} (${resolved.resolution})`, resolved);
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
