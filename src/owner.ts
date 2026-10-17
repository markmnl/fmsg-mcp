/**
 * Sub-addresses, stated once. `@user_agent@example.com` is a sub-address of `@user@example.com`: the
 * owner can switch to it in their client, but can only follow and reply to a thread they are a
 * participant of. So messages a sub-address sends include the owner as a recipient unless the
 * model passes include_owner: false.
 */
import * as z from "zod/v4";
import { sameAddress } from "./address.js";

/** The instructions sentence after the identity: concrete when the owner is known, conditional otherwise. */
export function ownerSentence(owner: string | undefined): string {
  return owner
    ? `Messages you send include ${owner} as a recipient unless include_owner is false, so they can follow and reply.`
    : "If whoami shows an owner, messages you send include them as a recipient unless include_owner is false.";
}

/** The include_owner argument for send-type tools; undefined when the caller is known to be an owner's own address. */
export function includeOwnerSchema(address: string | undefined, owner: string | undefined): z.ZodDefault<z.ZodBoolean> | undefined {
  if (address && !owner) return undefined;
  return z.boolean().default(true).describe(owner ? `also send to your owner ${owner}` : "also send to your owner, if whoami shows one");
}

/** The recipients with the caller's owner appended, unless include_owner is false (unknown: the argument is only registered for possible sub-addresses) or they are already present. */
export function withOwner(caller: { owner?: string }, recipients: string[], includeOwner: unknown): string[] {
  const owner = caller.owner;
  if (!owner || includeOwner === false || recipients.some((r) => sameAddress(r, owner))) return recipients;
  return [...recipients, owner];
}
