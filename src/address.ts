const ADDRESS = /^@([^@\s/]+)@([^@\s/]+)$/u;
/**
 * fmsg specification, Addresses: the user part is Unicode letters and numbers, with `-`, `_` or `.`
 * between them (never consecutive, never first or last).
 */
const USER_PART = /^[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)*$/u;
/** Host names (including internationalised ones) and an optional port; no backslashes, spaces or controls. */
const DOMAIN_PART = /^[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}._:-]*[\p{L}\p{N}\p{M}])?$/u;
/** The specification limits a whole address to under 256 bytes. */
const MAX_ADDRESS_BYTES = 255;

/**
 * Validate an fmsg address and normalise it to `@user@domain`. The user part keeps
 * its case: the Web API compares `from` to the token's address byte for byte, and
 * hosts may treat user names case-sensitively. Only the domain is lower-cased.
 * Returns undefined when malformed, including Markdown-escaped copies such as `@bob\_x@example.com`.
 */
export function normalizeFmsgAddress(value: string): string | undefined {
  const trimmed = value.trim();
  const match = ADDRESS.exec(trimmed);
  if (!match || !USER_PART.test(match[1]!) || !DOMAIN_PART.test(match[2]!)) return undefined;
  const address = `@${match[1]!}@${match[2]!.toLowerCase()}`;
  return Buffer.byteLength(address, "utf8") <= MAX_ADDRESS_BYTES ? address : undefined;
}

/** Why a value shaped like `@user@domain` is still not a valid address. */
function invalidAddressReason(value: string): string | undefined {
  const match = ADDRESS.exec(value);
  if (!match) return /^@[^@]*@[^@]*$/u.test(value) ? "it contains spaces, slashes or control characters" : undefined;
  if (value.includes("\\")) return "it contains a backslash; remove any Markdown escaping copied from formatted text";
  if (!USER_PART.test(match[1]!)) return "the user part may contain only letters and digits, with single . _ or - between them";
  if (!DOMAIN_PART.test(match[2]!)) return "the domain is not a valid host name";
  return "it is longer than 255 bytes";
}

/** Case-insensitive address equality. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function isFmsgAddress(value: string): boolean {
  return normalizeFmsgAddress(value) !== undefined;
}

/** Reserved FMSG_DEFAULT_DOMAIN value: short names resolve on the caller's own domain. */
export const CALLER_DOMAIN = "caller";

/**
 * The domain short names resolve to: the configured default domain, or with
 * `caller` the domain of the address the server acts as. Undefined when neither
 * is known (no default domain, or `caller` before the caller address is known).
 */
export function effectiveDefaultDomain(defaultDomain: string | undefined, callerAddress?: string): string | undefined {
  if (defaultDomain !== CALLER_DOMAIN) return defaultDomain;
  const match = callerAddress ? ADDRESS.exec(callerAddress.trim()) : null;
  return match ? match[2]!.toLowerCase() : undefined;
}

export type Resolution = "literal" | "directory" | "default_domain";

export type AddressResolver = {
  /** A domain, or CALLER_DOMAIN to use the domain of `callerAddress`. */
  defaultDomain?: string;
  directory?: Record<string, string>;
  /** The address the server acts as, when known. */
  callerAddress?: string;
};

export type ResolvedAddress = { address: string; resolution: Resolution };

/**
 * Resolve a full address or short name: literal `@user@domain` first, then a
 * configured directory entry, then `@name@<default domain>` (the caller's own
 * domain when the default domain is `caller`).
 */
export function resolveAddress(name: string, resolver: AddressResolver = {}): ResolvedAddress {
  const trimmed = name.trim();
  const literal = normalizeFmsgAddress(trimmed);
  if (literal) return { address: literal, resolution: "literal" };
  const invalid = invalidAddressReason(trimmed);
  if (invalid) throw new Error(`"${name}" is not a valid fmsg address: ${invalid}`);
  if (trimmed.includes("\\")) {
    throw new Error(`"${name}" contains a backslash, which no fmsg address or short name has; remove any Markdown escaping copied from formatted text`);
  }
  if (trimmed === "" || /[@\s/\\\p{Cc}]/u.test(trimmed)) {
    throw new Error(`"${name}" is not an fmsg address (@user@domain) or a resolvable short name`);
  }
  const key = trimmed.toLowerCase();
  const directory = resolver.directory ?? {};
  for (const [entry, target] of Object.entries(directory)) {
    if (entry.toLowerCase() === key) {
      const address = normalizeFmsgAddress(target);
      if (!address) throw new Error(`directory entry "${entry}" maps to an invalid address "${target}"`);
      return { address, resolution: "directory" };
    }
  }
  const domain = effectiveDefaultDomain(resolver.defaultDomain, resolver.callerAddress);
  if (domain) {
    const address = normalizeFmsgAddress(`@${trimmed}@${domain}`);
    if (address) return { address, resolution: "default_domain" };
  }
  throw new Error(
    `"${name}" is not a full fmsg address and no directory entry or default domain resolves it; ask for the full @user@domain address`,
  );
}

export function resolveAddresses(names: string[], resolver: AddressResolver = {}): string[] {
  const out: string[] = [];
  for (const name of names) {
    const { address } = resolveAddress(name, resolver);
    if (!out.some((existing) => sameAddress(existing, address))) out.push(address);
  }
  return out;
}
