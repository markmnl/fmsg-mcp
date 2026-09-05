const ADDRESS = /^@([^@\s/]+)@([^@\s/]+)$/u;

/**
 * Validate an fmsg address and normalise it to `@user@domain`. The user part keeps
 * its case: the Web API compares `from` to the token's address byte for byte, and
 * hosts may treat user names case-sensitively. Only the domain is lower-cased.
 * Returns undefined when malformed.
 */
export function normalizeFmsgAddress(value: string): string | undefined {
  const trimmed = value.trim();
  const match = ADDRESS.exec(trimmed);
  if (!match) return undefined;
  return `@${match[1]!}@${match[2]!.toLowerCase()}`;
}

/** Case-insensitive address equality. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function isFmsgAddress(value: string): boolean {
  return normalizeFmsgAddress(value) !== undefined;
}

export type Resolution = "literal" | "directory" | "default_domain";

export type AddressResolver = {
  defaultDomain?: string;
  directory?: Record<string, string>;
};

export type ResolvedAddress = { address: string; resolution: Resolution };

/**
 * Resolve a full address or short name: literal `@user@domain` first, then a
 * configured directory entry, then `@name@<default domain>`.
 */
export function resolveAddress(name: string, resolver: AddressResolver = {}): ResolvedAddress {
  const trimmed = name.trim();
  const literal = normalizeFmsgAddress(trimmed);
  if (literal) return { address: literal, resolution: "literal" };
  if (trimmed === "" || /[@\s/]/u.test(trimmed)) {
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
  if (resolver.defaultDomain) {
    const address = normalizeFmsgAddress(`@${trimmed}@${resolver.defaultDomain}`);
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
