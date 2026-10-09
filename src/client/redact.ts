/** Not preceded or followed by another key character, so a match is a whole token. */
const START = String.raw`(?<![A-Za-z0-9_-])`;
const END = String.raw`(?![A-Za-z0-9_-])`;

/**
 * Patterns for secrets that must never leave the process in message bodies or logs. Each is a credential format
 * with a distinctive prefix (or, for secret access keys, a distinctive label), so ordinary text is not touched.
 */
const PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  [/\bfmsgk_[A-Za-z0-9+/=._~-]{6,}\b/gu, "[REDACTED_FMSG_API_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/gu, "[REDACTED_JWT]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/gu, "[REDACTED_GITHUB_TOKEN]"],
  [new RegExp(`${START}glpat-[A-Za-z0-9_-]{20,}${END}`, "gu"), "[REDACTED_ACCESS_TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED_API_KEY]"],
  // Payment-platform secret, restricted and webhook-signing keys (sk_live_…, rk_test_…, whsec_…).
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bwhsec_[A-Za-z0-9+/=]{24,}/gu, "[REDACTED_API_KEY]"],
  // Cloud API keys with the AIza prefix: 39 characters in all.
  [new RegExp(`${START}AIza[0-9A-Za-z_-]{35}${END}`, "gu"), "[REDACTED_API_KEY]"],
  // Chat-platform bot, user, app and refresh tokens (xoxb-…, xoxp-…, xapp-…).
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}|\bxapp-[0-9]-[A-Za-z0-9-]{10,}/gu, "[REDACTED_CHAT_TOKEN]"],
  // Cloud access key ids: long-term (AKIA…) and temporary (ASIA…), always 20 upper-case letters and digits.
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED_ACCESS_KEY_ID]"],
  // A 40-character secret access key next to its usual label (aws_secret_access_key = …, "SecretAccessKey": "…").
  [
    /\b((?:aws_?)?secret_?access_?key|aws_?secret_?key)(["']?\s*[:=]\s*["']?)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/giu,
    (_match, label: string, separator: string) => `${label}${separator}[REDACTED_SECRET_ACCESS_KEY]`,
  ],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gu, "[REDACTED_PRIVATE_KEY]"],
];

export type Redacted = { text: string; count: number };

/** Replace secrets with placeholders and report how many were replaced. */
export function redactSecrets(text: string): Redacted {
  let count = 0;
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, (match: string, ...groups: string[]) => {
      count += 1;
      return typeof replacement === "string" ? replacement : replacement(match, ...groups);
    });
  }
  return { text: out, count };
}

/** One-line, secret-free rendering of an error for logs and tool results. */
export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).text.replace(/[\r\n\u2028\u2029]+/gu, " ").slice(0, 2000);
}
