import { describe, expect, it } from "vitest";
import {
  OFFICIAL_DOCS,
  VERIFIED_FACTS,
  answerFromKnowledge,
  bestSourceFor,
  fetchOfficialDoc,
  groundingFacts,
  harvestKbLinks,
  searchKnowledge,
  stripHtml,
  tokenize
} from "../src/knowledge/teamviewerDocs.js";
import { embedLocal, embedModelId } from "../src/knowledge/localEmbedder.js";

describe("knowledge layer", () => {
  it("tokenizes and drops stopwords", () => {
    const tokens = tokenize("Which ports are used by TeamViewer?");
    expect(tokens).toContain("ports");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("teamviewer");
  });

  it("strips html to plain searchable text", () => {
    const html = "<html><head><style>x{}</style></head><body><h1>Ports</h1><p>5938 &amp; 443</p><script>bad()</script></body></html>";
    const text = stripHtml(html);
    expect(text).toContain("Ports");
    expect(text).toContain("5938 & 443");
    expect(text).not.toContain("bad()");
    expect(text).not.toContain("<");
  });

  it("finds the primary-port fact for a connectivity query", () => {
    const hits = searchKnowledge("which port does teamviewer use through the firewall");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].kind).toBe("fact");
    expect(hits.some((h) => h.text.includes("5938"))).toBe(true);
  });

  it("finds the web api base fact for an api query", () => {
    const hits = searchKnowledge("teamviewer web api bearer token base url devices");
    expect(hits.some((h) => h.text.includes("webapi.teamviewer.com"))).toBe(true);
  });

  it("uses an in-process local ONNX embedder (no Foundry Local for embeddings)", async () => {
    // Embeddings run locally via Transformers.js. The default model is the small
    // MiniLM ONNX model, overridable with TWC_EMBED_MODEL. The empty-input path
    // is deterministic and needs no model download.
    expect(embedModelId()).toBe("Xenova/all-MiniLM-L6-v2");
    const empty = await embedLocal([]);
    expect(empty.vectors).toEqual([]);
    expect(empty.model).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("rejects non-allowlisted hosts (SSRF guard)", async () => {
    const result = await fetchOfficialDoc("https://example.com/evil");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/allowlist/i);
  });

  it("rejects non-https arbitrary hosts", async () => {
    const result = await fetchOfficialDoc("http://169.254.169.254/latest/meta-data");
    expect(result.ok).toBe(false);
  });

  it("provides grounding facts filtered by topic", () => {
    const facts = groundingFacts(["ports"]);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((f) => f.includes("5938"))).toBe(true);
  });

  it("filters grounding facts by product", () => {
    const facts = groundingFacts(["product"], "teamviewer-dex");
    expect(facts.some((f) => f.toLowerCase().includes("1e"))).toBe(true);
    expect(facts.every((f) => !f.toLowerCase().includes("tensor"))).toBe(true);
  });

  it("picks a relevant official source for a query", () => {
    const src = bestSourceFor("web api token authentication");
    expect(src.topics).toContain("web-api");
  });

  it("every verified fact points to a known official source url", () => {
    const urls = new Set(OFFICIAL_DOCS.map((d) => d.url));
    for (const fact of VERIFIED_FACTS) {
      expect(urls.has(fact.source)).toBe(true);
    }
  });

  it("harvests only allowlisted KB links from Jina markdown", () => {
    const md = [
      "[Sign In](https://community.teamviewer.com/English/entry/signin?target=x)",
      "[TeamViewer Tensor](https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-tensor/)",
      '[Which ports](https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-remote/get-started/which-ports-are-used/ "tooltip")',
      "[Article 4139](https://community.teamviewer.com/English/kb/articles/4139-ports)",
      "[Knowledge Base](https://www.teamviewer.com/en/global/support/knowledge-base/)",
      "[Pricing](https://www.teamviewer.com/en/pricing/)",
      "[Evil](https://example.com/kb/articles/1-evil)"
    ].join("\n");
    const links = harvestKbLinks(md);
    const urls = links.map((l) => l.url);
    // Keeps real KB pages (allowlisted host + KB path), strips link titles.
    expect(urls).toContain("https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-tensor");
    expect(urls).toContain("https://community.teamviewer.com/English/kb/articles/4139-ports");
    expect(urls.some((u) => u.includes("which-ports-are-used"))).toBe(true);
    // Drops nav (Sign In), the KB root itself, non-KB pages, and other hosts.
    expect(urls.some((u) => u.includes("signin"))).toBe(false);
    expect(urls).not.toContain("https://www.teamviewer.com/en/global/support/knowledge-base");
    expect(urls.some((u) => u.includes("/pricing"))).toBe(false);
    expect(urls.some((u) => u.includes("example.com"))).toBe(false);
  });

  it("de-duplicates KB links by normalized URL", () => {
    const md = [
      "[Tensor](https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-tensor/)",
      "[Tensor again](https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-tensor)"
    ].join("\n");
    expect(harvestKbLinks(md)).toHaveLength(1);
  });
});
