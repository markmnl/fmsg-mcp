import type { AuthInfo, ServerContext } from "@modelcontextprotocol/server";
import { FmsgClient } from "./client/client.js";

/** A resolved caller: the client bound to one API key and the address it acts as. */
export type Caller = {
  client: FmsgClient;
  address: string;
  /** When the key's exchanged token expires (ms since epoch), for whoami. */
  tokenExpiresAt: () => Promise<number>;
};

/** Supplies the caller for a request: a fixed one over stdio, per bearer key over HTTP. */
export interface CallerProvider {
  forRequest(authInfo: AuthInfo | undefined): Promise<Caller>;
}

export class StaticCallerProvider implements CallerProvider {
  private caller?: Promise<Caller>;
  constructor(private readonly client: FmsgClient) {}
  forRequest(): Promise<Caller> {
    this.caller ??= (async () => {
      const address = await this.client.address();
      return { client: this.client, address, tokenExpiresAt: async () => (await this.client.getToken()).expiresAtMs };
    })();
    return this.caller;
  }
}

export async function callerFor(provider: CallerProvider, ctx: ServerContext): Promise<Caller> {
  return provider.forRequest(ctx.http?.authInfo);
}
