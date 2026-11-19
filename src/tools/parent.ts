/**
 * The parent of a reply. A recipient added to a message after it was sent (add-to) is a participant of that
 * message only through the batch that added them, so the Web API takes their reply only with that batch's hash
 * as the parent. They are not a participant of the rest of the thread and cannot reply there.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { sameAddress } from "../address.js";
import { FmsgHttpError } from "../client/client.js";
import type { FmsgMessage } from "../client/types.js";
import type { Caller } from "../context.js";
import { toolError } from "../errors.js";

/** How a draft names its parent: the parent's id, plus the hash to reply through when the caller was added later. */
export type ParentReference = { pid: string; parentSha256?: string };

const SHA256_HEX = /^[0-9a-f]{64}$/iu;

/** Whether the caller was added to `message` after it was sent, rather than being its sender or a recipient. */
export function addedOnly(caller: Pick<Caller, "address">, message: FmsgMessage): boolean {
  if (sameAddress(message.from, caller.address) || message.to.some((a) => sameAddress(a, caller.address))) return false;
  return (message.add_to ?? []).some((b) => (b.to ?? []).some((a) => sameAddress(a, caller.address)));
}

/**
 * The parent reference for a reply from `caller` to `parent`. An added recipient replies through the hash of the
 * batch that added them. A host that gives no batch hash predates the rule, so the id alone is sent there.
 */
export function parentReference(caller: Pick<Caller, "address">, parent: FmsgMessage): ParentReference {
  if (!addedOnly(caller, parent)) return { pid: parent.id };
  const batch = (parent.add_to ?? []).find((b) => (b.to ?? []).some((a) => sameAddress(a, caller.address)));
  const hash = batch?.sha256;
  return typeof hash === "string" && SHA256_HEX.test(hash) ? { pid: parent.id, parentSha256: hash.toLowerCase() } : { pid: parent.id };
}

type AddToBatch = NonNullable<FmsgMessage["add_to"]>[number];

/**
 * Who holds a message: its sender and recipients. An add-to batch is a message of its own, the original's contents
 * with a wider audience, so its holders are also the batch's adder and the recipients it added.
 */
export function holdersOf(message: FmsgMessage, batch?: AddToBatch): string[] {
  const seen = new Map<string, string>();
  const add = (addr?: string) => {
    if (addr && !seen.has(addr.toLowerCase())) seen.set(addr.toLowerCase(), addr);
  };
  add(message.from);
  for (const a of message.to) add(a);
  if (batch) {
    add(batch.add_to_from);
    for (const a of batch.to ?? []) add(a);
  }
  return [...seen.values()];
}

/** The batch that added the caller to `message`, when they were only added. */
export function callerBatch(caller: Pick<Caller, "address">, message: FmsgMessage): AddToBatch | undefined {
  if (!addedOnly(caller, message)) return undefined;
  return (message.add_to ?? []).find((b) => (b.to ?? []).some((a) => sameAddress(a, caller.address)));
}

/**
 * The parent a reply to `parent` names so that everyone on it holds that parent: to reply to a message, you and
 * everyone on your reply must have it, whichever host they are on. That is the message itself, or the add-to batch
 * that brought in the people added (the caller's own batch when they were only added). An error result when no
 * one message is held by them all; `owner` is the caller's owner, dropped rather than failing when they don't hold it.
 */
export function replyTarget(
  caller: Pick<Caller, "address">, parent: FmsgMessage, to: string[], owner?: string,
): { to: string[]; ref: ParentReference; ownerLeftOff: boolean } | CallToolResult {
  const hashed = (b: AddToBatch) => typeof b.sha256 === "string" && SHA256_HEX.test(b.sha256);
  const own = callerBatch(caller, parent);
  // Added only, the caller holds just their batch; otherwise the message, or any batch of it.
  const candidates: Array<AddToBatch | undefined> = own ? [own] : [undefined, ...(parent.add_to ?? []).filter(hashed)];
  const fits = (b: AddToBatch | undefined, recipients: string[]) => {
    const held = new Set(holdersOf(parent, b).map((a) => a.toLowerCase()));
    return recipients.every((a) => held.has(a.toLowerCase()));
  };
  const isOwner = (a: string) => owner !== undefined && sameAddress(a, owner);
  for (const recipients of to.some(isOwner) ? [to, to.filter((a) => !isOwner(a))] : [to]) {
    if (!recipients.length) continue;
    const i = candidates.findIndex((b) => fits(b, recipients));
    if (i < 0) continue;
    const b = candidates[i];
    // A host that gives no batch hash predates the rule: the id alone is all there is to send.
    const ownerLeftOff = recipients.length < to.length;
    return { to: recipients, ownerLeftOff, ref: b && hashed(b) ? { pid: parent.id, parentSha256: b.sha256!.toLowerCase() } : { pid: parent.id } };
  }
  const held = new Set(holdersOf(parent, own).map((a) => a.toLowerCase()));
  const missing = to.filter((a) => !held.has(a.toLowerCase()) && !isOwner(a));
  return toolError(
    `everyone on a reply must have the message it replies to: ${missing.join(", ")} ` +
    `${missing.length === 1 ? "doesn't" : "don't"} have message ${parent.id}` +
    (own ? "" : ", or any one add-to of it with all of them") +
    `. Add them first with add_recipients, then reply, or leave them off.`,
  );
}

/** Inbox pages searched for the message the caller was added to; only on the error path. */
const SEARCH_PAGES = 5;
const PAGE_SIZE = 100;
/** Threads fetched while searching, so a large inbox cannot turn one failed reply into many requests. */
const SEARCH_THREADS = 20;

/**
 * The message the caller was added to in the thread above `target`, when `target` is an earlier message there that
 * the caller cannot reply to. Searches the caller's recent inbox for messages it was added to whose thread contains
 * `target`. Returns undefined when none is found.
 */
export async function addedMessageBelow(caller: Caller, target: string, signal: AbortSignal): Promise<string | undefined> {
  const candidates: FmsgMessage[] = [];
  for (let page = 0; page < SEARCH_PAGES; page++) {
    const items = await caller.client.listInbox(PAGE_SIZE, page * PAGE_SIZE, signal);
    candidates.push(...items.filter((m) => m.id !== target && addedOnly(caller, m)));
    if (items.length < PAGE_SIZE) break;
  }
  const direct = candidates.find((m) => m.pid === target);
  if (direct) return direct.id;
  for (const m of candidates.filter((c) => c.pid).slice(0, SEARCH_THREADS)) {
    try {
      const thread = await caller.client.getThreadMessages(m.id, signal);
      if (thread.messages.some((x) => x.id === target)) return m.id;
    } catch (error) {
      if (!(error instanceof FmsgHttpError) || error.status === 401) throw error;
    }
  }
  return undefined;
}

/** The error for a reply to a message in a thread the caller can reply to only lower down, at `added`. */
export function notParticipantError(target: string, added: string): CallToolResult {
  return toolError(
    `You cannot reply to message ${target}: you are not a participant of it. You were added to message ${added} ` +
      `in the same thread after it was sent, so you can reply to message ${added} instead (pass id ${added}).`,
  );
}

/**
 * Fetch the message a reply goes to. When it cannot be read because the caller is not a participant of it, but the
 * caller was added to a later message in its thread, return an error naming that message.
 */
export async function replyParent(caller: Caller, id: string, signal: AbortSignal): Promise<FmsgMessage | CallToolResult> {
  try {
    return await caller.client.getMessage(id, signal);
  } catch (error) {
    if (!(error instanceof FmsgHttpError) || ![403, 404].includes(error.status)) throw error;
    const added = await addedMessageBelow(caller, id, signal).catch(() => undefined);
    if (added) return notParticipantError(id, added);
    throw error;
  }
}

/** The note for a reply that left the caller's owner off because they don't have the message replied to. */
export function ownerLeftOffNote(owner: string | undefined, leftOff: boolean): string {
  return leftOff && owner ? ` (not to ${owner}: they don't have the message replied to; add them to it with add_recipients first to include them)` : "";
}
