/**
 * fmsg message ids are int64 values serialised as bare JSON numbers. JavaScript
 * numbers lose precision above 2^53, so ids are kept as decimal strings and
 * only ever cross the JSON boundary through the helpers below.
 */

const MAX_INT64 = 9_223_372_036_854_775_807n;

type ReviverContext = { source?: string };
type ParseWithContext = (
  text: string,
  reviver: (this: unknown, key: string, value: unknown, context: ReviverContext) => unknown,
) => unknown;

/** Validate and normalise an id (number or digit string) to its decimal string form. */
export function normalizeMessageId(value: unknown, label = "message id"): string {
  let raw: string;
  if (typeof value === "string") raw = value.trim();
  else if (typeof value === "number" && Number.isSafeInteger(value)) raw = String(value);
  else if (typeof value === "bigint") raw = value.toString();
  else throw new Error(`invalid ${label}: ${String(value)}`);
  if (!/^[0-9]+$/u.test(raw)) throw new Error(`invalid ${label}: ${raw}`);
  const big = BigInt(raw);
  if (big < 1n || big > MAX_INT64) throw new Error(`out-of-range ${label}: ${raw}`);
  return big.toString();
}

export function compareMessageIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function minMessageId(ids: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const id of ids) if (best === undefined || compareMessageIds(id, best) < 0) best = id;
  return best;
}

export function maxMessageId(ids: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const id of ids) if (best === undefined || compareMessageIds(id, best) > 0) best = id;
  return best;
}

/** JSON keys whose numeric values are int64 ids on the fmsg wire. */
const ID_KEYS = new Set(["id", "pid", "batch_id", "root_id", "trigger_id"]);

/**
 * Parse fmsg JSON, converting id fields to exact decimal strings using the
 * reviver's `context.source` (the original number text, Node 21+).
 */
export function parseFmsgJson<T = unknown>(text: string): T {
  const parse = JSON.parse as unknown as ParseWithContext;
  return parse(text, function (key, value, context) {
    if (ID_KEYS.has(key) && typeof value === "number") {
      const source = context?.source;
      if (source && /^[0-9]+$/u.test(source)) return source;
      return normalizeMessageId(value, key);
    }
    return value;
  }) as T;
}

/**
 * Serialise an object, emitting the given id fields as bare int64 numbers.
 * `ids` values must already be normalised decimal strings.
 */
export function stringifyWithIds(value: Record<string, unknown>, ids: Record<string, string>): string {
  const entries = Object.entries(ids).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return JSON.stringify(value);
  for (const [k] of entries) {
    if (Object.hasOwn(value, k)) throw new Error(`JSON already contains ${k}`);
  }
  const base = JSON.stringify(value);
  const extra = entries.map(([k, v]) => `${JSON.stringify(k)}:${normalizeMessageId(v, k)}`).join(",");
  return base === "{}" ? `{${extra}}` : `${base.slice(0, -1)},${extra}}`;
}
