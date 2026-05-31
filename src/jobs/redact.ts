// Best-effort redaction of common PII / secret patterns from free-text
// inputs before they're written to .twc-data (logs + jobs.json). This is
// a defense-in-depth measure — users should still avoid pasting raw
// secrets, but accidental email/IP/token leaks won't end up on disk.

type Replacement = string | ((substring: string, ...args: string[]) => string);

const PATTERNS: Array<[RegExp, Replacement]> = [
  // jwt — three base64url segments separated by dots
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]"],
  // bearer / api-key style tokens (long base64-ish or hex strings, 20+ chars)
  [/\b(?:sk|pk|ghp|ghs|gho|github_pat|xoxb|AIza)[-_A-Za-z0-9]{20,}\b/g, "[REDACTED_TOKEN]"],
  // emails
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]"],
  // ipv4
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]"],
  // simple "password=…" / "secret=…" inline pairs — runs LAST so specific token
  // patterns above get their typed marker. Skips values already redacted.
  [/\b(password|passwd|secret|api[_-]?key|token)\s*[=:]\s*("[^"]+"|'[^']+'|\[REDACTED_[A-Z]+\]|\S+)/gi,
    (_m: string, key: string, value: string) =>
      value.startsWith("[REDACTED_") ? `${key}=${value}` : `${key}=[REDACTED]`]
];

export function redactSensitive(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  let out = input;
  for (const [re, replacement] of PATTERNS) {
    out = typeof replacement === "string" ? out.replace(re, replacement) : out.replace(re, replacement);
  }
  return out;
}

export interface RedactableInput {
  target: string;
  issue: string;
  context?: string;
}

export function redactJobInput<T extends RedactableInput>(input: T): T {
  return {
    ...input,
    target: redactSensitive(input.target) ?? input.target,
    issue: redactSensitive(input.issue) ?? input.issue,
    context: redactSensitive(input.context)
  };
}
