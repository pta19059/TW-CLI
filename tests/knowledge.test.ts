import { describe, expect, it } from "vitest";
import {
  OFFICIAL_DOCS,
  VERIFIED_FACTS,
  answerFromKnowledge,
  bestSourceFor,
  fetchOfficialDoc,
  groundingFacts,
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
});
