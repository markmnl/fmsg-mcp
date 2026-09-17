import { isLoopbackHost } from "../client/url.js";

export type OAuthConfig = {
  resourceUrl: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  exchangeAudience: string;
  addressClaim: string;
};

/** Preserve exact issuer/resource identifiers while checking their transport and shape. */
export function oauthUrl(value: string, label: string, allowQuery = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute HTTPS URL`); }
  if (url.username || url.password || (!allowQuery && url.search) || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))) {
    throw new Error(`${label} requires HTTPS (HTTP only on loopback), without credentials${allowQuery ? "" : ", query"} or fragment`);
  }
  return value;
}

export function loadOAuthConfig(env: NodeJS.ProcessEnv, transport: string): OAuthConfig | undefined {
  const mode = env.FMSG_MCP_AUTH_MODE ?? "api-key";
  if (mode !== "api-key" && mode !== "oauth") throw new Error("FMSG_MCP_AUTH_MODE must be api-key or oauth");
  const configured = Object.keys(env).some(key => key.startsWith("FMSG_MCP_OAUTH_") && env[key]);
  if (mode === "api-key") {
    if (configured) throw new Error("Set FMSG_MCP_AUTH_MODE=oauth to use FMSG_MCP_OAUTH_* settings");
    return undefined;
  }
  if (transport !== "http") throw new Error("OAuth mode requires HTTP; use API-key mode for stdio");
  const required = (suffix: string) => {
    const name = `FMSG_MCP_OAUTH_${suffix}`;
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required in OAuth mode`);
    return value;
  };
  const resourceUrl = oauthUrl(required("RESOURCE_URL"), "MCP resource URL");
  const issuerUrl = oauthUrl(required("ISSUER_URL"), "OAuth issuer URL");
  const exchangeAudience = required("EXCHANGE_AUDIENCE");
  if (exchangeAudience === resourceUrl) throw new Error("OAuth exchange audience must differ from the MCP resource URL");
  return {
    resourceUrl, issuerUrl, exchangeAudience,
    clientId: required("CLIENT_ID"), clientSecret: required("CLIENT_SECRET"),
    addressClaim: env.FMSG_MCP_OAUTH_ADDRESS_CLAIM?.trim() || "sub",
  };
}
