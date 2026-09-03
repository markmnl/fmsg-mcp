/** Patterns for secrets that must never leave the process in message bodies or logs. */
const PATTERNS: Array<[RegExp, string]> = [
  [/\bfmsgk_[A-Za-z0-9+/=._~-]{6,}\b/gu, "[REDACTED_FMSG_API_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/gu, "[REDACTED_JWT]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/gu, "[REDACTED_GITHUB_TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED_API_KEY]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED_PRIVATE_KEY]"],
];

export type Redacted = { text: string; count: number };

/** Replace secrets with placeholders and report how many were replaced. */
export function redactSecrets(text: string): Redacted {
  let count = 0;
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, () => {
      count += 1;
      return replacement;
    });
  }
  return { text: out, count };
}

/** One-line, secret-free rendering of an error for logs and tool results. */
export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).text.replace(/[\r\n\u2028\u2029]+/gu, " ").slice(0, 2000);
}
