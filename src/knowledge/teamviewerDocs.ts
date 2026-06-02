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
import { embedLocal, embedModelId } from "./localEmbedder.js";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Jina AI Reader fetches pages server-side and returns clean Markdown, which
// bypasses the Cloudflare/WAF TLS block that rejects every direct client
// (Node, browser, curl) for teamviewer.com from restricted networks. Free, no
// API key required (an optional JINA_API_KEY raises rate limits).
const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 25_000;
// Local hybrid RAG index built from the official docs (see reindexOfficialDocs).
const INDEX_FILE = path.join(KNOWLEDGE_DIR, "rag-index.json");

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
  /** Semantic cosine similarity to the query (docs only; facts are keyword). */
  sem?: number;
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

/** A retrievable unit of an official doc (one section of one page). */
export interface IndexChunk {
  id: string;
  docId: string;
  url: string;
  title: string;
  text: string;
  /** Optional embedding (present only when Foundry Local produced one). */
  embedding?: number[];
}

export interface LocalIndex {
  version: 1;
  builtAt: string;
  embeddingModel?: string;
  chunks: IndexChunk[];
}

// ── Just-in-time retrieval (lightweight URL map of the whole KB) ─────────────
//
// The curated OFFICIAL_DOCS cover common questions. For long-tail questions we
// keep a *lightweight* map of KB article URLs/titles (metadata only, no
// embeddings — a few KB on disk for the whole knowledge base). When the curated
// core can't answer confidently, we pick the best-matching URLs from this map,
// fetch them live via Jina, embed them on the fly, and answer from that fresh
// context. Newly fetched chunks are folded back into the local index so the
// next identical question is answered instantly from the core.

/** One discoverable KB page: just enough metadata to rank and fetch it. */
export interface KbLink {
  url: string;
  title: string;
}

export interface UrlMap {
  version: 1;
  builtAt: string;
  links: KbLink[];
}

const URL_MAP_FILE = path.join(KNOWLEDGE_DIR, "url-map.json");
const URL_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** KB landing page whose Jina markdown lists the whole knowledge-base tree. */
const KB_ROOT_URL = "https://www.teamviewer.com/en/global/support/knowledge-base/";
/** How many candidate pages just-in-time retrieval may fetch per question. */
const JIT_MAX_PAGES = 3;

/** Drop obvious navigation/chrome links that are not documentation pages. */
const NAV_LINK_RE = /sign\s?in|skip to|cookie|privacy|imprint|legal|contact|careers/i;

/**
 * Extract TeamViewer knowledge-base links from a Jina markdown document. Pure
 * (no I/O) so it is unit-testable. Keeps only allowlisted hosts and real KB
 * paths, strips link titles/fragments, and de-duplicates by normalized URL.
 */
export function harvestKbLinks(markdown: string): KbLink[] {
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  const seen = new Set<string>();
  const out: KbLink[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const title = m[1].replace(/\s+/g, " ").trim();
    const rawUrl = m[2].trim();
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (!DOC_HOST_ALLOWLIST.includes(host)) continue;
    const isKb =
      /\/support\/knowledge-base\//i.test(url.pathname) || /\/kb\/articles\//i.test(url.pathname);
    if (!isKb) continue;
    // Normalize: drop fragment/query, collapse trailing slash.
    const normalized = `${url.origin}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
    if (normalized === `${new URL(KB_ROOT_URL).origin}${new URL(KB_ROOT_URL).pathname.replace(/\/+$/, "")}`.toLowerCase()) {
      continue; // skip the root itself
    }
    if (seen.has(normalized)) continue;
    if (!title || /^image\b/i.test(title) || NAV_LINK_RE.test(title)) continue;
    seen.add(normalized);
    out.push({ url: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, title });
  }
  return out;
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
 * Fetch an official documentation page via the Jina AI Reader (server-side,
 * returns clean Markdown), strip nothing, and cache it. Jina is used because
 * teamviewer.com sits behind a Cloudflare/WAF TLS block that rejects every
 * direct client; Jina fetches from its own servers and so reaches the page.
 * Only allowlisted hosts are permitted (the target URL, not Jina, is checked).
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
  const timer = setTimeout(() => controller.abort(), JINA_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: "text/plain", "X-Return-Format": "markdown" };
    const key = process.env.JINA_API_KEY;
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${JINA_READER_BASE}${url}`, { signal: controller.signal, headers });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, url, status: res.status, error: `HTTP ${res.status}` };
    }
    const title = OFFICIAL_DOCS.find((d) => d.url === url)?.title;
    writeCacheEntry({ url, title, text: text.slice(0, 300_000), fetchedAt: new Date().toISOString() });
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

// ── URL map (just-in-time discovery) ────────────────────────────────────────

function loadUrlMap(): UrlMap | null {
  try {
    if (!existsSync(URL_MAP_FILE)) return null;
    return JSON.parse(readFileSync(URL_MAP_FILE, "utf8")) as UrlMap;
  } catch {
    return null;
  }
}

/**
 * (Re)build the lightweight URL map by harvesting the KB landing page via Jina.
 * Stores only URLs + titles (no embeddings), so the whole knowledge base costs
 * just a few KB on disk. Returns the number of links discovered.
 */
export async function buildUrlMap(): Promise<{ links: number; ok: boolean; detail: string }> {
  const r = await fetchOfficialDoc(KB_ROOT_URL, true);
  if (!r.ok || !r.text) {
    return { links: 0, ok: false, detail: r.error ?? "failed to fetch the knowledge-base index" };
  }
  const links = harvestKbLinks(r.text);
  const map: UrlMap = { version: 1, builtAt: new Date().toISOString(), links };
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(URL_MAP_FILE, JSON.stringify(map), "utf8");
  return { links: links.length, ok: links.length > 0, detail: `${links.length} KB links` };
}

/** Load the URL map, rebuilding it lazily when missing or stale. */
async function ensureUrlMap(): Promise<UrlMap | null> {
  const existing = loadUrlMap();
  if (existing && Date.now() - new Date(existing.builtAt).getTime() < URL_MAP_TTL_MS) {
    return existing;
  }
  const built = await buildUrlMap().catch(() => ({ ok: false }) as { ok: boolean });
  return built.ok ? loadUrlMap() : existing;
}

/** Summary of the URL map for `docs map`. */
export function urlMapInfo(): { built: boolean; builtAt?: string; links: number } {
  const map = loadUrlMap();
  if (!map) return { built: false, links: 0 };
  return { built: true, builtAt: map.builtAt, links: map.links.length };
}

/** Decode a KB URL path into search-friendly words for lexical ranking. */
function urlSlugWords(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname)
      .replace(/\/(en|english|global|support|knowledge-base|kb|articles)\//gi, " ")
      .replace(/[-/_]+/g, " ");
  } catch {
    return "";
  }
}

/**
 * Just-in-time retrieval: pick the best-matching KB pages from the URL map,
 * fetch them live via Jina, embed them on the fly, and return the strongest
 * chunks. Newly embedded chunks are folded into the local index so the next
 * identical question is answered instantly from the core. Network/embedding
 * failures resolve to an empty list (the caller falls back to "I don't know").
 */
export async function retrieveJustInTime(query: string, limit = 5): Promise<KnowledgeHit[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const map = await ensureUrlMap();
  if (!map || map.links.length === 0) return [];

  // Rank candidate pages lexically (title + URL slug) and fetch the top few.
  const candidates = map.links
    .map((l) => ({ l, score: scoreText(tokens, `${l.title} ${urlSlugWords(l.url)}`) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, JIT_MAX_PAGES);
  if (candidates.length === 0) return [];

  const freshChunks: IndexChunk[] = [];
  for (const { l } of candidates) {
    const r = await fetchOfficialDoc(l.url).catch(() => null);
    if (!r || !r.ok || !r.text) continue;
    const docId = createHash("sha1").update(l.url).digest("hex").slice(0, 12);
    chunkMarkdown(r.text).forEach((text, i) => {
      if (isJunkChunk(text)) return; // don't index or rank error-page bodies
      freshChunks.push({ id: `jit-${docId}#${i}`, docId: `jit-${docId}`, url: l.url, title: l.title, text });
    });
  }
  if (freshChunks.length === 0) return [];

  // Embed the query and the fresh chunks together (one local batch).
  const { vectors, model } = await embedTexts([query, ...freshChunks.map((c) => c.text)]);
  const queryVec = vectors[0];
  freshChunks.forEach((c, i) => {
    c.embedding = vectors[i + 1];
  });

  const scored = freshChunks.map((c) => ({
    c,
    kw: scoreText(tokens, `${c.title} ${c.text}`),
    sem: cosineSimilarity(queryVec, c.embedding!)
  }));

  // Fold the fetched chunks into the local index for next time (best-effort).
  enrichLocalIndex(freshChunks, model);

  // Same hybrid RRF fusion + dedup as the core index, so live results are
  // ranked on equal footing.
  const ranked = fuseHybrid(scored, Math.max(limit * 4, 20));
  const hits = ranked.map((s) => ({
    kind: "doc" as const,
    text: bestSnippet(s.c.text, tokens),
    score: s.kw + s.sem * 3,
    sem: s.sem,
    source: s.c.url,
    title: s.c.title
  }));
  return dedupeHits(hits).slice(0, limit);
}

/** Append freshly embedded chunks to the on-disk index (deduped by id). */
function enrichLocalIndex(chunks: IndexChunk[], model: string): void {
  try {
    const idx = loadLocalIndex();
    if (!idx) return; // no core index yet; nothing to enrich
    const have = new Set(idx.chunks.map((c) => c.id));
    const additions = chunks.filter((c) => c.embedding && c.embedding.length > 0 && !have.has(c.id));
    if (additions.length === 0) return;
    idx.chunks.push(...additions);
    idx.builtAt = new Date().toISOString();
    if (!idx.embeddingModel) idx.embeddingModel = model;
    writeFileSync(INDEX_FILE, JSON.stringify(idx), "utf8");
  } catch {
    /* enrichment is best-effort */
  }
}


// ── Local hybrid RAG index ──────────────────────────────────────────────────
//
// `docs reindex` fetches every official source via Jina, splits it into chunks,
// optionally embeds them with Foundry Local, and writes a single index file.
// At query time `retrieveLocal` scores chunks with a hybrid of keyword overlap
// (always available, deterministic) and semantic cosine similarity (when
// embeddings exist). No web search happens at query time.

/** Split Markdown into ~maxChars chunks, preferring paragraph boundaries. */
/**
 * Strip navigation/footer "link soup" from Jina markdown before chunking. KB
 * pages fetched via Jina carry huge menus and footers rendered as bullet lists
 * of links; if indexed, those lists match almost any keyword and drown out the
 * real prose. We drop image-only lines and list items whose visible text — once
 * the [label](url) markup is removed — is essentially just a link, plus obvious
 * navigation boilerplate. Prose paragraphs (real sentences) are preserved.
 */
export function denoiseMarkdown(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      kept.push("");
      continue;
    }
    // Drop pure image lines.
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(t)) continue;
    const isListItem = /^([*+-]|\d+\.)\s/.test(t);
    // A list item whose entire content is just link(s) (no prose around them)
    // is a menu/footer entry, however descriptive the link label — drop it.
    if (isListItem) {
      const body = t.replace(/^([*+-]|\d+\.)\s+/, "");
      const residual = body
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/[^a-z0-9]/gi, "");
      if (/\]\(https?:\/\//.test(body) && residual.length === 0) continue;
    }
    // Visible text once links/images are unwrapped to their label only.
    const unwrapped = t
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const hasLink = /\]\(https?:\/\//.test(t);
    const letters = unwrapped.replace(/[^a-z0-9]/gi, "").length;
    // A list item that is just a link (little residual text) is navigation.
    if (isListItem && hasLink && letters < 25) continue;
    // Obvious nav/boilerplate lines.
    if (NAV_LINK_RE.test(t) && letters < 40) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

export function chunkMarkdown(text: string, maxChars = 1200, overlap = 150): string[] {
  const clean = denoiseMarkdown(text).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const paras = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    const c = cur.trim();
    if (c.length >= 40) chunks.push(c);
    cur = "";
  };
  for (const raw of paras) {
    const para = raw.trim();
    if (!para) continue;
    if (cur.length + para.length + 2 <= maxChars) {
      cur = cur ? `${cur}\n\n${para}` : para;
    } else if (para.length <= maxChars) {
      flush();
      cur = para;
    } else {
      flush();
      for (let i = 0; i < para.length; i += maxChars - overlap) {
        chunks.push(para.slice(i, i + maxChars).trim());
      }
    }
  }
  flush();
  return chunks.filter((c) => c.length >= 40);
}

/** Cosine similarity of two equal-length vectors (0 when missing/degenerate). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Embed texts for the hybrid RAG index. Embeddings are MANDATORY — there is no
 * keyword-only fallback. They run on a small local ONNX model in-process (see
 * localEmbedder), which is fully local, free and offline once cached. Foundry
 * Local cannot serve embeddings (its catalog ships only chat-completion models),
 * so embeddings run here. The model id comes from TWC_EMBED_MODEL (default
 * Xenova/all-MiniLM-L6-v2). Throws if the model cannot be loaded.
 */
async function embedTexts(texts: string[]): Promise<{ vectors: number[][]; model: string }> {
  if (texts.length === 0) throw new Error("embedTexts called with no input.");
  try {
    return await embedLocal(texts);
  } catch (err) {
    throw new Error(
      `Local embedding model '${embedModelId()}' could not be used (${err instanceof Error ? err.message : String(err)}). ` +
        "The first run downloads the model from the Hugging Face hub; ensure network access, or set TWC_EMBED_MODEL to a cached model. There is no fallback."
    );
  }
}

function loadLocalIndex(): LocalIndex | null {
  try {
    if (!existsSync(INDEX_FILE)) return null;
    return JSON.parse(readFileSync(INDEX_FILE, "utf8")) as LocalIndex;
  } catch {
    return null;
  }
}

/** Summary of the on-disk index for `docs index`. */
export function localIndexInfo(): {
  built: boolean;
  builtAt?: string;
  chunks: number;
  embeddings: number;
  model?: string;
} {
  const idx = loadLocalIndex();
  if (!idx) return { built: false, chunks: 0, embeddings: 0 };
  return {
    built: true,
    builtAt: idx.builtAt,
    chunks: idx.chunks.length,
    embeddings: idx.chunks.filter((c) => c.embedding && c.embedding.length > 0).length,
    model: idx.embeddingModel
  };
}

/**
 * Rebuild the local RAG index from the official sources via Jina, then embed
 * every chunk with Foundry Local. Embeddings are MANDATORY: if Foundry Local is
 * unavailable or has no embedding model, this throws (no keyword-only index is
 * written). Returns a per-source result.
 */
export async function reindexOfficialDocs(): Promise<
  { id: string; ok: boolean; detail: string; chunks: number }[]
> {
  const results: { id: string; ok: boolean; detail: string; chunks: number }[] = [];
  const allChunks: IndexChunk[] = [];
  for (const doc of OFFICIAL_DOCS) {
    const r = await fetchOfficialDoc(doc.url, true);
    if (!r.ok || !r.text) {
      results.push({ id: doc.id, ok: false, detail: r.error ?? "failed", chunks: 0 });
      continue;
    }
    const pieces = chunkMarkdown(r.text);
    pieces.forEach((text, i) =>
      allChunks.push({ id: `${doc.id}#${i}`, docId: doc.id, url: doc.url, title: doc.title, text })
    );
    results.push({ id: doc.id, ok: true, detail: `${pieces.length} chunks`, chunks: pieces.length });
  }

  if (allChunks.length === 0) {
    throw new Error("No documentation could be fetched, so the index cannot be built.");
  }

  // Mandatory embeddings — throws if Foundry Local is unavailable. We do not
  // write a keyword-only index: hybrid retrieval requires embeddings.
  const { vectors, model } = await embedTexts(allChunks.map((c) => c.text));
  vectors.forEach((v, i) => {
    allChunks[i].embedding = v;
  });

  const index: LocalIndex = {
    version: 1,
    builtAt: new Date().toISOString(),
    embeddingModel: model,
    chunks: allChunks
  };
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(index), "utf8");
  return results;
}

/**
 * Retrieve from the local RAG index with mandatory hybrid scoring: keyword
 * overlap plus semantic cosine similarity. Foundry Local embeddings are
 * required — both the chunks (built by `docs reindex`) and the query are
 * embedded. If the index lacks embeddings or Foundry Local is unavailable, this
 * throws (no keyword-only fallback). Pure-local: no web search.
 */
export async function retrieveLocal(query: string, limit = 5): Promise<KnowledgeHit[]> {
  const idx = loadLocalIndex();
  if (!idx || idx.chunks.length === 0) {
    throw new Error("No local documentation index found. Run 'twc docs reindex' first.");
  }
  if (!idx.chunks.every((c) => c.embedding && c.embedding.length > 0)) {
    throw new Error(
      "The local index has no embeddings. Rebuild it with 'twc docs reindex' while Foundry Local is running. Hybrid retrieval requires embeddings — there is no fallback."
    );
  }
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  // Mandatory query embedding — throws if Foundry Local is unavailable.
  const queryVec = (await embedTexts([query])).vectors[0];

  const scored = idx.chunks
    .filter((c) => !isJunkChunk(c.text))
    .map((c) => ({
      c,
      kw: scoreText(tokens, `${c.title} ${c.text}`),
      sem: cosineSimilarity(queryVec, c.embedding!)
    }));

  // Azure-Search-style hybrid: fuse the keyword ranking and the vector ranking
  // with Reciprocal Rank Fusion over a generous candidate pool, then drop
  // near-identical passages (overlapping chunks of the same page) before
  // returning the top `limit`. RRF keeps a strong lexical match from being
  // buried by semantic noise and vice-versa.
  const ranked = fuseHybrid(scored, Math.max(limit * 4, 20));
  const hits = ranked.map((s) => ({
    kind: "doc" as const,
    text: bestSnippet(s.c.text, tokens),
    score: s.kw + s.sem * 3,
    sem: s.sem,
    source: s.c.url,
    title: s.c.title
  }));
  return dedupeHits(hits).slice(0, limit);
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

/**
 * Fraction of distinct query content-tokens (stemmed) that actually appear in a
 * passage. This is the lexical-grounding signal behind confidence: a passage
 * that only shares one common word (e.g. "windows") with a multi-word question
 * scores low and is rejected, routing the query to the live KB instead.
 * Matching is tolerant of inflections (use/used/using, connect/connection) via a
 * shared 4-char prefix, since the light stemmer only strips a trailing "s".
 */
function queryCoverage(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const hayTokens = tokenize(text);
  const hayStems = new Set(hayTokens.map(stem));
  const q = new Set(queryTokens.map(stem));
  let matched = 0;
  for (const t of q) {
    if (hayStems.has(t)) {
      matched += 1;
      continue;
    }
    const p = t.slice(0, 4);
    if (t.length >= 3 && hayTokens.some((h) => h.startsWith(p) || (h.length >= 4 && t.startsWith(h.slice(0, 4))))) {
      matched += 1;
    }
  }
  return matched / q.size;
}

/**
 * Blended relevance for ranking a mixed pool of doc + fact hits. Lexical
 * coverage leads; semantic similarity is a half-weight tiebreaker (the heavy
 * vector lifting already happened during RRF retrieval); a curated fact that
 * genuinely matches the question gets a decisive bonus so a precise verified
 * statement headlines instead of a generic page that merely scores high on
 * cosine.
 */
function hitRelevance(queryTokens: string[], h: KnowledgeHit): number {
  const cov = queryCoverage(queryTokens, `${h.title ?? ""} ${h.text}`);
  const factBonus = h.kind === "fact" && cov >= 0.5 ? 0.4 : 0;
  return cov + 0.5 * (h.sem ?? 0) + factBonus;
}

function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Reject error/placeholder chunks that Jina sometimes captures (a moved page
 * returns a "404 page not found" body). These embed and keyword-match like any
 * other passage, so without an explicit guard they leak into answers as noise.
 */
function isJunkChunk(text: string): boolean {
  return /404 page not found|page not found|page (?:could not|couldn'?t) be found|the page you (?:are|were) looking for/i.test(
    text
  );
}

/** Drop near-identical passages, keeping the first (highest-ranked) occurrence. */
function dedupeHits(hits: KnowledgeHit[]): KnowledgeHit[] {
  const seen = new Set<string>();
  const out: KnowledgeHit[] = [];
  for (const h of hits) {
    const key = `${h.source}|${normalizeForDedup(h.text).slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * Reciprocal Rank Fusion of a keyword ranking and a semantic ranking — the same
 * idea Azure AI Search uses to combine BM25 and vector results. Each list
 * contributes 1/(K+rank); chunks ranked highly by either signal float to the
 * top. K=60 is the standard RRF constant.
 */
function fuseHybrid(
  scored: { c: IndexChunk; kw: number; sem: number }[],
  limit: number
): { c: IndexChunk; kw: number; sem: number }[] {
  const K = 60;
  const fused = new Map<IndexChunk, number>();
  [...scored]
    .filter((s) => s.kw > 0)
    .sort((a, b) => b.kw - a.kw)
    .forEach((s, i) => fused.set(s.c, (fused.get(s.c) ?? 0) + 1 / (K + i + 1)));
  [...scored]
    .sort((a, b) => b.sem - a.sem)
    .forEach((s, i) => fused.set(s.c, (fused.get(s.c) ?? 0) + 1 / (K + i + 1)));
  return scored
    .map((s) => ({ s, fused: fused.get(s.c) ?? 0 }))
    // Require at least some signal (a keyword match or a non-trivial cosine).
    .filter(({ s }) => s.kw > 0 || s.sem >= 0.2)
    .sort((a, b) => b.fused - a.fused)
    .slice(0, limit)
    .map(({ s }) => s);
}

/**
 * Tidy a snippet for display: drop markdown header hashes, list bullets, table
 * rows and stray backticks, then collapse the remaining prose onto one line so
 * a multi-section chunk reads as a sentence instead of a soup of headings.
 */
function tidySnippet(text: string, width = 320, opts: { keepUrls?: boolean } = {}): string {
  let flat = text
    .replace(/`/g, "")
    // Drop the Jina front-matter block (Title:/URL Source:/Published Time:/…)
    // that precedes the real content when a chunk starts at the page top.
    .replace(/^[\s\S]*?Markdown Content:\s*/i, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !/^\|.*\|$/.test(l) &&
        !/^[-|: ]+$/.test(l) &&
        !/^(Title|URL Source|Published Time|Last Modified):/i.test(l)
    )
    .join(" ")
    // Inline markdown cleanup (markers can sit mid-line after windowing):
    .replace(/^\S*:\/\/\S*\s*/, "") // leading URL fragment left by windowing
    .replace(/!\[[^\]]*\]\([^)\s]*\)?/g, " ") // images (tolerant of cut close)
    .replace(/\[([^\]]*)\]\([^)\s]*\)?/g, "$1") // links → label only (tolerant)
    .replace(/\[\s*\]\(?[^)\s]*\)?/g, " "); // empty links (whole or windowed)
  // Strip bare URLs only for doc snippets (Jina link soup). Curated facts may
  // contain a meaningful URL (e.g. the Web API base URL) that IS the answer.
  if (!opts.keepUrls) flat = flat.replace(/https?:\/\/\S+/g, " ");
  flat = flat
    .replace(/(^|\s)#{1,6}(?=\s)/g, " ") // stray ## headers
    .replace(/\*\*|__/g, " ") // bold markers → space (avoid gluing words)
    .replace(/(^|\s)[*+]\s+/g, " ") // residual list bullets
    .replace(/\[[^\]]*$/, "") // dangling link label with no closing bracket
    .replace(/[*_#>\s]+$/g, "") // trailing stray markdown / bullets
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > width ? `${flat.slice(0, width).trim()}…` : flat;
}

function bestSnippet(text: string, queryTokens: string[], width = 300): string {
  const lower = text.toLowerCase();
  let bestIdx = -1;
  for (const t of queryTokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (bestIdx < 0 || i < bestIdx)) bestIdx = i;
  }
  if (bestIdx < 0) return text.slice(0, width).trim();
  // Open the window at the start of the sentence containing the match so the
  // snippet reads as a complete thought rather than a mid-sentence fragment.
  let start = Math.max(0, bestIdx - 90);
  const lead = text.slice(start, bestIdx);
  const boundary = lead.match(/.*[.!?]\s+/s);
  if (boundary) start += boundary[0].length;
  let window = text.slice(start, start + width);
  // Close the window at the last sentence boundary inside it (when past the
  // halfway point) so we don't cut a word in half.
  const lastEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  let cleanEnd = false;
  if (lastEnd > width * 0.5) {
    window = window.slice(0, lastEnd + 1);
    cleanEnd = true;
  }
  return (start > 0 ? "…" : "") + window.trim() + (cleanEnd ? "" : "…");
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
 * Answer a question from the knowledge layer: verified facts + the local RAG
 * index (built by `docs reindex`). When the curated core can't answer
 * confidently, a just-in-time pass discovers the best-matching KB pages from the
 * lightweight URL map, fetches them live via Jina, embeds them on the fly and
 * answers from that fresh context (folding the new chunks back into the index).
 * Set TWC_NO_JIT=1 to disable the live pass. When nothing is confidently
 * grounded, return an honest "I don't know" pointing to the official source.
 */
export async function answerFromKnowledge(
  query: string
): Promise<KnowledgeAnswer> {
  const tokens = tokenize(query);
  // A doc hit is trustworthy only when it is BOTH lexically grounded (a real
  // fraction of the question's words appear in the passage, not just one common
  // word) AND semantically close. Verified facts are curated, so a strong
  // keyword coverage alone suffices. Anything weaker falls through to the live
  // KB rather than answering from an off-topic page.
  const COVERAGE_MIN = 0.6;
  const SEM_MIN = 0.42;
  const isConfident = (h: KnowledgeHit[]): boolean => {
    if (h.length === 0) return false;
    const top = h[0];
    const cov = queryCoverage(tokens, `${top.title ?? ""} ${top.text}`);
    if (top.kind === "fact") return cov >= 0.5;
    return cov >= COVERAGE_MIN && (top.sem ?? 0) >= SEM_MIN;
  };

  // Rank the mixed pool by blended relevance (lexical coverage + semantic
  // similarity), which keeps doc and fact hits on a single comparable scale.
  const rerank = (pool: KnowledgeHit[]): KnowledgeHit[] =>
    dedupeHits([...pool].sort((a, b) => hitRelevance(tokens, b) - hitRelevance(tokens, a))).slice(0, 5);

  const localHits = await retrieveLocal(query, 5);
  let hits = rerank([...localHits, ...searchKnowledge(query, 5)]);
  let confident = isConfident(hits);

  // Just-in-time fallback: the curated core didn't answer confidently, so reach
  // into the wider KB (URL map → live fetch → on-the-fly embeddings).
  if (!confident && process.env.TWC_NO_JIT !== "1") {
    const jit = await retrieveJustInTime(query, 5).catch(() => [] as KnowledgeHit[]);
    if (jit.length > 0) {
      hits = rerank([...hits, ...jit]);
      confident = isConfident(hits);
    }
  }

  if (!confident) {
    const src = bestSourceFor(query);
    // Only surface a partial passage if it is at least lexically on-topic;
    // otherwise an off-topic snippet is worse than an honest "I don't know".
    const lead =
      hits.length > 0 && queryCoverage(tokens, `${hits[0].title ?? ""} ${hits[0].text}`) >= 0.34
        ? `I only have partial information. Best available: ${tidySnippet(hits[0].text)}`
        : "I don't have a verified answer to that.";
    return {
      answer:
        `${lead}\nFor an authoritative answer, consult the official TeamViewer documentation: ${src.title} — ${src.url}` +
        (localIndexInfo().built ? "" : " (run 'twc docs reindex' to build the local index)."),
      confident: false,
      // Cite only sources we actually drew on; never invent a citation.
      citations: hits.length > 0 ? Array.from(new Set(hits.map((h) => h.source))).slice(0, 3) : [src.url],
      hits
    };
  }

  // Anchor the answer to the single best-matching page so we never stitch
  // fragments of unrelated product pages into one reply. Supporting lines are
  // taken ONLY from the same source as the top hit (a coherent passage),
  // de-duplicated, and a single strongly-overlapping verified fact may be
  // appended for grounding.
  const top = hits[0];
  const sameSource = hits.filter((h) => h.source === top.source);
  const seenLines: string[] = [];
  const lines: string[] = [];
  // True when `cand` adds nothing over a line we already kept (identical, or one
  // contains the other — e.g. a short header fragment of a longer passage).
  const isRedundant = (cand: string): boolean =>
    seenLines.some((s) => s.includes(cand) || cand.includes(s));
  for (const h of sameSource) {
    const snip = tidySnippet(h.text, 320, { keepUrls: h.kind === "fact" });
    const norm = normalizeForDedup(snip);
    if (snip.length < 15 || isRedundant(norm)) continue;
    seenLines.push(norm);
    lines.push(h.kind === "fact" ? `• ${snip}` : `• ${h.title}: ${snip}`);
    if (lines.length >= 3) break;
  }
  if (top.kind === "doc") {
    const fact = hits.find(
      (h) => h.kind === "fact" && h.source !== top.source && queryCoverage(tokens, h.text) >= 0.5
    );
    if (fact) {
      const snip = tidySnippet(fact.text, 320, { keepUrls: true });
      if (snip && !isRedundant(normalizeForDedup(snip))) lines.push(`• ${snip}`);
    }
  }
  // Citations: the anchor source first, then any other source actually used in
  // the answer lines — nothing fabricated.
  const usedSources = Array.from(new Set([top.source, ...sameSource.map((h) => h.source)]));
  const orderedCitations = usedSources.slice(0, 3);
  return {
    answer: lines.join("\n") || tidySnippet(top.text),
    confident: true,
    citations: orderedCitations,
    hits
  };
}
