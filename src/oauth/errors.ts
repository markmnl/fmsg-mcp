import { AsyncLocalStorage } from "node:async_hooks";
import { FmsgHttpError } from "../client/errors.js";

export type OAuthRequestState = { scopes: string[]; error?: OAuthRequestError };
export const oauthRequestState = new AsyncLocalStorage<OAuthRequestState>();

/** Preserve authentication failures when a tool/resource maps them to an MCP result. */
export function recordOAuthFailure(error: unknown): void {
  const state = oauthRequestState.getStore();
  if (!state) return;
  if (error instanceof OAuthRequestError) state.error = error;
  else if (error instanceof FmsgHttpError && error.status === 401) state.error = invalidToken();
  else if (error instanceof FmsgHttpError && error.insufficientScope) state.error = new OAuthRequestError(403, "insufficient_scope",
    "The Web API requires additional scope or refuses this route for delegated tokens.", state.scopes);
}

/** Safe, server-authored authentication failures; never include issuer response bodies or credentials. */
export class OAuthRequestError extends Error {
  constructor(readonly status: 401 | 403 | 500 | 503, readonly code: string, message: string, readonly scopes: string[] = []) {
    super(message);
    this.name = "OAuthRequestError";
  }
}

export const invalidToken = () => new OAuthRequestError(401, "invalid_token", "The OAuth connection must be refreshed or reconnected.");
export const insufficientScope = (scopes: string[]) => new OAuthRequestError(403, "insufficient_scope", "The OAuth connection does not authorize this operation.", scopes);

export function oauthErrorResponse(error: OAuthRequestError, metadataUrl: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (error.status === 401 || error.status === 403) {
    let challenge = `Bearer resource_metadata=${JSON.stringify(metadataUrl)}, error=${JSON.stringify(error.code)}`;
    if (error.scopes.length) challenge += `, scope=${JSON.stringify(error.scopes.join(" "))}`;
    headers.set("www-authenticate", challenge);
  }
  return Response.json({ error: error.code, error_description: error.message }, { status: error.status, headers });
}
