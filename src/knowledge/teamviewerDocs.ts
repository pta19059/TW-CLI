// ────────────────────────────────────────────────────────────────────────────
// TeamViewer knowledge layer
//
// Gives the agents grounded context for troubleshooting. Two sources:
//   1. VERIFIED_FACTS — a small, curated set of facts confirmed against the
//      official TeamViewer KB and the Web API v1 OpenAPI spec. Always available,
//      fully offline, so the agents are never ungrounded.
//   2. OFFICIAL_DOCS — canonical TeamViewer documentation URLs the agents can
//      read on demand (direct fetch). Fetched pages are stripped to text and
//      cached on disk so a second lookup is instant and works offline.
//
// Security: only hosts on DOC_HOST_ALLOWLIST may be fetched. Callers pass a
// natural-language query, never a raw URL, so arbitrary-URL SSRF is not possible.
// ────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { KNOWLEDGE_DIR } from "../paths.js";
import { ProductKey } from "../types.js";

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Only these hosts may be fetched by the knowledge layer. */
const DOC_HOST_ALLOWLIST = [
  "www.teamviewer.com",
  "teamviewer.com",
  "community.teamviewer.com",
  "webapi.teamviewer.com",
  "integrate.teamviewer.com",
  "dl.teamviewer.com"
];

export type DocTopic =
  | "connectivity"
  | "ports"
  | "auth-policy"
  | "web-api"
  | "endpoint-health"
  | "logs"
  | "product"
  | "general";

export interface DocSource {
  id: string;
  title: string;
  url: string;
  topics: DocTopic[];
  /** Products this source is most relevant to (empty = all). */
  products?: ProductKey[];
}

export interface VerifiedFact {
  id: string;
  statement: string;
  /** Extra keywords (beyond the statement words) that should match this fact. */
  keywords: string[];
  topics: DocTopic[];
  /** Official source URL this fact was verified against. */
  source: string;
  products?: ProductKey[];
}

export interface KnowledgeHit {
  kind: "fact" | "doc";
  text: string;
  score: number;
  source: string;
  title?: string;
}

export interface KnowledgeAnswer {
  answer: string;
  confident: boolean;
  citations: string[];
  hits: KnowledgeHit[];
}

export interface DocFetchResult {
  ok: boolean;
  url: string;
  status?: number;
  text?: string;
  error?: string;
  fromCache?: boolean;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ── Curated official documentation sources ──────────────────────────────────

/**
 * Generic landing source used as an honest fallback when a query matches no
 * specific document. Pointing here (instead of an arbitrary first article)
 * avoids misleading users toward an unrelated topic.
 */
export const GENERAL_SUPPORT_SOURCE: DocSource = {
  id: "support-home",
  title: "TeamViewer Knowledge Base",
  url: "https://www.teamviewer.com/en/global/support/knowledge-base/",
  topics: ["general"]
};

export const OFFICIAL_DOCS: DocSource[] = [
  {
    id: "ports",
    title: "Which ports are used by TeamViewer?",
    url: "https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-remote/get-started/which-ports-are-used-by-teamviewer/",
    topics: ["ports", "connectivity"]
  },
  {
    id: "ports-community",
    title: "Which ports are used by TeamViewer? (Community KB)",
    url: "https://community.teamviewer.com/English/kb/articles/4139-which-ports-are-used-by-teamviewer",
    topics: ["ports", "connectivity"]
  },
  {
    id: "web-api",
    title: "TeamViewer Web API v1 documentation",
    url: "https://webapi.teamviewer.com/api/v1/docs/index",
    topics: ["web-api", "auth-policy"]
  },
  {
    id: "integrate-api",
    title: "TeamViewer Integrations / API",
    url: "https://integrate.teamviewer.com/en/develop/api/",
    topics: ["web-api", "auth-policy"]
  },
  {
    id: "product-remote",
    title: "TeamViewer Remote",
    url: "https://www.teamviewer.com/en/products/remote/",
    topics: ["product"],
    products: ["teamviewer-remote"]
  },
  {
    id: "product-tensor",
    title: "TeamViewer Tensor",
    url: "https://www.teamviewer.com/en/products/tensor/",
    topics: ["product", "auth-policy"],
    products: ["teamviewer-tensor"]
  },
  {
    id: "product-frontline",
    title: "TeamViewer Frontline",
    url: "https://www.teamviewer.com/en/products/frontline/",
    topics: ["product"],
    products: ["teamviewer-frontline", "teamviewer-assist-ar"]
  },
  {
    id: "product-remote-management",
    title: "TeamViewer Remote Management",
    url: "https://www.teamviewer.com/en/products/remote/solutions/remote-management/",
    topics: ["product", "endpoint-health"],
    products: ["teamviewer-remote-management"]
  },
  {
    id: "product-dex",
    title: "TeamViewer Digital Employee Experience (DEX)",
    url: "https://www.teamviewer.com/en/products/digital-employee-experience/",
    topics: ["product", "endpoint-health"],
    products: ["teamviewer-dex"]
  }
];

// ── Verified facts (confirmed against official docs) ────────────────────────
export const VERIFIED_FACTS: VerifiedFact[] = [
  {
    id: "port-5938",
    statement:
      "TeamViewer prefers outbound TCP and UDP port 5938 — the primary port; firewalls should allow it at a minimum.",
    keywords: ["5938", "port", "firewall", "outbound", "udp", "tcp", "primary"],
    topics: ["ports", "connectivity"],
    source: OFFICIAL_DOCS[0].url
  },
  {
    id: "port-443-80",
    statement:
      "If port 5938 is unavailable, TeamViewer falls back to TCP 443, then TCP 80 (slower and less reliable).",
    keywords: ["443", "80", "fallback", "port", "https", "blocked"],
    topics: ["ports", "connectivity"],
    source: OFFICIAL_DOCS[0].url
  },
  {
    id: "no-host-list",
    statement:
      "TeamViewer does not publish a fixed server IP/hostname list; all server IPs have PTR records resolving to *.teamviewer.com, and the guidance is to allow outbound 5938 regardless of destination IP.",
    keywords: ["ip", "hostname", "whitelist", "ptr", "*.teamviewer.com", "destination", "proxy", "allowlist"],
    topics: ["ports", "connectivity"],
    source: OFFICIAL_DOCS[0].url
  },
  {
    id: "webapi-base",
    statement:
      "The TeamViewer Web API base URL is https://webapi.teamviewer.com/api/v1 and requires a bearer token (script token or OAuth).",
    keywords: ["webapi", "api", "token", "bearer", "oauth", "script token", "base url"],
    topics: ["web-api", "auth-policy"],
    source: OFFICIAL_DOCS[2].url
  },
  {
    id: "webapi-paths",
    statement:
      "Documented Web API v1 endpoints include /ping, /account, /devices, /users, /managed/groups, /managed/devices, /usergroups, /userroles and /TeamViewerPolicies.",
    keywords: ["account", "devices", "users", "managed", "groups", "usergroups", "userroles", "policies", "ping", "endpoint"],
    topics: ["web-api", "auth-policy"],
    source: OFFICIAL_DOCS[2].url
  },
  {
    id: "dex-1e",
    statement:
      "TeamViewer DEX (Digital Employee Experience) is based on TeamViewer's acquisition of 1E and is delivered via the 1E Client agent on endpoints.",
    keywords: ["dex", "1e", "digital employee experience", "agent", "endpoint"],
    topics: ["product", "endpoint-health"],
    source: OFFICIAL_DOCS[8].url,
    products: ["teamviewer-dex"]
  },
  {
    id: "core-service",
    statement:
      "The TeamViewer desktop client runs a background service (Windows: 'TeamViewer'/'TeamViewer_Service'; Linux: teamviewerd; macOS: com.teamviewer.teamviewerd) that must be running for sessions to work.",
    keywords: ["service", "teamviewerd", "daemon", "background", "windows", "linux", "macos", "process"],
    topics: ["endpoint-health"],
    source: OFFICIAL_DOCS[4].url
  },
  {
    id: "tensor-sso",
    statement:
      "TeamViewer Tensor adds enterprise features on top of the core client: SSO (SAML), Conditional Access policies and centralized device/user management via the Web API.",
    keywords: ["tensor", "sso", "saml", "conditional access", "policy", "enterprise", "mass deployment"],
    topics: ["product", "auth-policy"],
    source: OFFICIAL_DOCS[5].url,
    products: ["teamviewer-tensor"]
  }
];

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "with", "you", "your", "that", "this", "can", "from", "what",
  "which", "how", "why", "does", "use", "used", "using", "have", "has", "not", "all", "any", "get",
  "tv", "teamviewer", "issue", "problem", "help",
  "of", "an", "is", "to", "in", "on", "at", "by", "or", "as", "be", "it", "if", "do", "we", "my",
  "via", "per", "but", "out", "its", "his", "her", "i.e", "e.g"
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9.*/_-]+/g) ?? [])
    .map((t) => t.replace(/^[.*/_-]+|[.*/_-]+$/g, ""))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Remove scripts/styles/tags and collapse whitespace so text is searchable. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#?[a-z0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAllowedHost(url: string): boolean {
  try {
    return DOC_HOST_ALLOWLIST.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function cacheFile(url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
  return path.join(KNOWLEDGE_DIR, `${hash}.json`);
}

interface CacheEntry {
  url: string;
  title?: string;
  text: string;
  fetchedAt: string;
}

function readCache(url: string): CacheEntry | null {
  try {
    const file = cacheFile(url);
    if (!existsSync(file)) return null;
    const entry = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    if (Date.now() - new Date(entry.fetchedAt).getTime() > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCacheEntry(entry: CacheEntry): void {
  try {
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    writeFileSync(cacheFile(entry.url), JSON.stringify(entry), "utf8");
  } catch {
    /* cache is best-effort */
  }
}

/** Return all currently cached official-doc entries (offline searchable). */
function loadCachedDocs(): CacheEntry[] {
  const out: CacheEntry[] = [];
  for (const doc of OFFICIAL_DOCS) {
    const entry = readCache(doc.url);
    if (entry) out.push({ ...entry, title: entry.title ?? doc.title });
  }
  return out;
}

/**
 * Fetch an official documentation page (direct, no archive fallback), strip it
 * to text and cache it. Only allowlisted hosts are permitted.
 */
export async function fetchOfficialDoc(url: string, force = false): Promise<DocFetchResult> {
  if (!isAllowedHost(url)) {
    return { ok: false, url, error: "Host not in the official TeamViewer documentation allowlist" };
  }
  if (!force) {
    const cached = readCache(url);
    if (cached) return { ok: true, url, text: cached.text, fromCache: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,application/json" }
    });
    const raw = await res.text();
    const text = raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[")
      ? raw // looks like JSON (e.g. an OpenAPI spec) — keep as-is
      : stripHtml(raw);
    if (!res.ok) {
      return { ok: false, url, status: res.status, error: `HTTP ${res.status}` };
    }
    const title = OFFICIAL_DOCS.find((d) => d.url === url)?.title;
    writeCacheEntry({ url, title, text: text.slice(0, 200_000), fetchedAt: new Date().toISOString() });
    return { ok: true, url, status: res.status, text };
  } catch (err) {
    return { ok: false, url, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Pre-fetch and cache every curated source. Returns a per-source result. */
export async function syncOfficialDocs(): Promise<{ id: string; ok: boolean; detail: string }[]> {
  const results: { id: string; ok: boolean; detail: string }[] = [];
  for (const doc of OFFICIAL_DOCS) {
    const r = await fetchOfficialDoc(doc.url, true);
    results.push({ id: doc.id, ok: r.ok, detail: r.ok ? "cached" : r.error ?? "failed" });
  }
  return results;
}

/** API key for Brave Search (free tier). Read from the environment, never hardcoded. */
function braveApiKey(): string | undefined {
  return process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || undefined;
}

/** True when a live web-search provider is configured (Brave API key present). */
export function isWebSearchConfigured(): boolean {
  return Boolean(braveApiKey());
}

/**
 * Live web search restricted to official TeamViewer hosts via the Brave Search
 * API (no local cache). Requires a free Brave API key in BRAVE_API_KEY. Returns
 * result titles, URLs and snippets so the knowledge layer can ground answers and
 * cite official pages even when those pages reject direct fetches (TLS/WAF).
 *
 * Brave is used instead of DuckDuckGo HTML: DDG is unofficial and serves an
 * anti-bot CAPTCHA (HTTP 202) on burst/automated traffic, whereas Brave is a
 * documented API with stable JSON and no CAPTCHA.
 */
export async function searchTeamViewerWeb(query: string, limit = 5): Promise<WebSearchResult[]> {
  const key = braveApiKey();
  if (!key) return []; // No provider configured — caller degrades to verified facts.

  const q = `site:teamviewer.com ${query}`.trim();
  const url =
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}` +
    `&count=${Math.min(Math.max(limit, 1), 20)}&safesearch=off`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": key }
    });
    if (res.status !== 200) return [];
    const data = (await res.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string }[] };
    };
    const results = data.web?.results ?? [];

    const out: WebSearchResult[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      if (out.length >= limit) break;
      const u = r.url ?? "";
      if (!u || seen.has(u) || !isAllowedHost(u)) continue;
      seen.add(u);
      out.push({
        title: stripHtml(r.title ?? ""),
        url: u,
        snippet: stripHtml(r.description ?? "")
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Light singular/plural normalization so "ports" matches "port". */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function scoreText(queryTokens: string[], haystack: string, extraKeywords: string[] = []): number {
  const hay = haystack.toLowerCase();
  const hayStems = new Set(tokenize(haystack).map(stem));
  const keywordStems = new Set(extraKeywords.map((k) => stem(k.toLowerCase())));
  let score = 0;
  for (const t of queryTokens) {
    const s = stem(t);
    if (keywordStems.has(s)) score += 2;
    else if (hayStems.has(s)) score += 1;
    else if (t.length >= 4 && hay.includes(t)) score += 1;
  }
  return score;
}

function bestSnippet(text: string, queryTokens: string[], width = 280): string {
  const lower = text.toLowerCase();
  let bestIdx = -1;
  for (const t of queryTokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (bestIdx < 0 || i < bestIdx)) bestIdx = i;
  }
  if (bestIdx < 0) return text.slice(0, width).trim();
  const start = Math.max(0, bestIdx - 60);
  return (start > 0 ? "…" : "") + text.slice(start, start + width).trim() + "…";
}

/**
 * Search the knowledge layer (verified facts + any cached official docs) for a
 * query. Pure/offline: never performs network I/O.
 */
export function searchKnowledge(query: string, limit = 5): KnowledgeHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const hits: KnowledgeHit[] = [];
  for (const fact of VERIFIED_FACTS) {
    const score = scoreText(tokens, `${fact.statement} ${fact.keywords.join(" ")}`, fact.keywords);
    if (score > 0) hits.push({ kind: "fact", text: fact.statement, score: score + 0.5, source: fact.source });
  }
  for (const doc of loadCachedDocs()) {
    const score = scoreText(tokens, doc.text);
    if (score > 0) {
      hits.push({ kind: "doc", text: bestSnippet(doc.text, tokens), score, source: doc.url, title: doc.title });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Pick the official source most relevant to a query, for honest fallbacks. */
export function bestSourceFor(query: string): DocSource {
  const tokens = tokenize(query);
  let best = GENERAL_SUPPORT_SOURCE;
  let bestScore = 0;
  for (const doc of OFFICIAL_DOCS) {
    const score = scoreText(tokens, `${doc.title} ${doc.topics.join(" ")} ${doc.id}`);
    if (score > bestScore) {
      bestScore = score;
      best = doc;
    }
  }
  return best;
}

/** Short grounded facts for a set of topics — injected into agent prompts. */
export function groundingFacts(topics: DocTopic[], product?: string, limit = 4): string[] {
  const wanted = new Set(topics);
  return VERIFIED_FACTS.filter((f) => {
    const topicMatch = f.topics.some((t) => wanted.has(t));
    const productMatch = !f.products || !product || f.products.includes(product as ProductKey);
    return topicMatch && productMatch;
  })
    .slice(0, limit)
    .map((f) => f.statement);
}

/**
 * Answer a question from the knowledge layer. With `live`, fetch the most
 * relevant official doc first (so cached text is available to the search).
 * When nothing is confidently grounded, return an honest "I don't know"
 * answer that points to the official source instead of guessing.
 */
export async function answerFromKnowledge(
  query: string,
  opts: { live?: boolean } = {}
): Promise<KnowledgeAnswer> {
  const webHits: KnowledgeHit[] = [];
  if (opts.live) {
    const src = bestSourceFor(query);
    await fetchOfficialDoc(src.url).catch(() => undefined);

    // Live web search restricted to official TeamViewer hosts (no cache).
    const tokens = tokenize(query);
    const results = await searchTeamViewerWeb(query).catch(() => [] as WebSearchResult[]);
    for (const r of results) {
      const raw = scoreText(tokens, `${r.title} ${r.snippet}`);
      if (raw <= 0) continue;
      const text = r.snippet || r.title;
      // Official, site-restricted results are trustworthy: boost so a relevant
      // hit clears the confidence bar even for short queries.
      webHits.push({ kind: "doc", text, score: raw + 1.5, source: r.url, title: r.title });
    }
  }

  const hits = [...webHits, ...searchKnowledge(query, 5)].sort((a, b) => b.score - a.score).slice(0, 5);
  const confident = hits.length > 0 && hits[0].score >= 2;
  const citations = Array.from(new Set(hits.map((h) => h.source))).slice(0, 3);

  if (!confident) {
    const src = bestSourceFor(query);
    const lead = hits.length > 0
      ? `I only have partial information. Best available: ${hits[0].text}`
      : "I don't have a verified answer to that.";
    return {
      answer:
        `${lead}\nFor an authoritative answer, consult the official TeamViewer documentation: ${src.title} — ${src.url}` +
        (opts.live ? "" : " (re-run with --live to read it directly)."),
      confident: false,
      citations: citations.length > 0 ? citations : [src.url],
      hits
    };
  }

  const factLines = hits.filter((h) => h.kind === "fact").slice(0, 3).map((h) => `• ${h.text}`);
  const docLines = hits.filter((h) => h.kind === "doc").slice(0, 2).map((h) => `• ${h.title}: ${h.text}`);
  const body = [...factLines, ...docLines].join("\n");
  return {
    answer: body || hits[0].text,
    confident: true,
    citations,
    hits
  };
}
