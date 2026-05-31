// Lightweight, deterministic natural-language intent parsing.
//
// Goal: let a user type a free-text sentence (the way they would talk to Tia)
// and have the CLI infer *which TeamViewer product* and *which target* the
// issue is about — without forcing --product / --target flags. This stays
// rule-based on purpose so it works with zero LLM dependency and is fully
// testable; the LLM layer (when present) still refines the diagnosis itself.

import { ProductKey } from "../types.js";
import { TEAMVIEWER_PRODUCTS } from "../catalog/teamviewerProducts.js";

export interface ParsedIntent {
  product?: ProductKey;
  target?: string;
}

interface Phrase {
  key: ProductKey;
  phrase: string;
}

// Build the candidate phrase list once (keys + names + aliases), longest first
// so "remote management" wins over the bare "remote" alias.
const PRODUCT_PHRASES: Phrase[] = TEAMVIEWER_PRODUCTS.flatMap((p) => {
  const phrases = new Set<string>([p.key, p.name.toLowerCase(), ...p.aliases.map((a) => a.toLowerCase())]);
  return [...phrases].map((phrase) => ({ key: p.key, phrase }));
}).sort((a, b) => b.phrase.length - a.phrase.length);

/** Infer the TeamViewer product mentioned in free text, or null if none. */
export function inferProduct(text: string): ProductKey | null {
  const haystack = ` ${text.toLowerCase()} `;
  for (const { key, phrase } of PRODUCT_PHRASES) {
    // word-boundary-ish match to avoid partial hits inside other words
    const needle = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`, "i").test(haystack)) {
      return key;
    }
  }
  return null;
}

const TARGET_KEYWORDS = "(?:target|device|host|hostname|machine|endpoint|pc|vm|server|computer)";
// Tokens that look like a hostname/IP but should not be mistaken for one.
const STOPWORDS = new Set([
  "teamviewer",
  "remote",
  "tensor",
  "frontline",
  "dex",
  "the",
  "my",
  "a",
  "this",
  "that",
  "is",
  "it",
  "and",
  "on"
]);

/** Infer a likely target identifier (hostname / device alias / IP) from text. */
export function inferTarget(text: string): string | null {
  // 1) explicit "... on <X>" / "device <X>" / "host named <X>" patterns.
  const labelled = new RegExp(
    `\\b${TARGET_KEYWORDS}\\s+(?:named\\s+|called\\s+|is\\s+|=\\s*)?([A-Za-z0-9][A-Za-z0-9._-]{1,62})`,
    "i"
  ).exec(text);
  if (labelled && !STOPWORDS.has(labelled[1].toLowerCase())) {
    return labelled[1];
  }

  // 2) bare IPv4.
  const ip = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/.exec(text);
  if (ip) return ip[1];

  // 3) hostname-like token: contains a hyphen or a dot, alphanumeric, not a stopword.
  const tokens = text.split(/\s+/);
  for (const raw of tokens) {
    const token = raw.replace(/[.,;:!?'"()]+$/g, "");
    if (/^[A-Za-z0-9]+([.-][A-Za-z0-9]+)+$/.test(token) && !STOPWORDS.has(token.toLowerCase())) {
      // skip product names that contain dots/hyphens (none today, but be safe)
      if (!inferProduct(token)) return token;
    }
  }

  return null;
}

/** Parse both product and target from a single free-text sentence. */
export function parseIntent(text: string): ParsedIntent {
  const product = inferProduct(text) ?? undefined;
  const target = inferTarget(text) ?? undefined;
  return { product, target };
}
