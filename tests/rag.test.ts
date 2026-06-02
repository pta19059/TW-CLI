import { describe, expect, it } from "vitest";
import { chunkMarkdown, cosineSimilarity } from "../src/knowledge/teamviewerDocs.js";

describe("chunkMarkdown", () => {
  it("returns an empty array for empty or whitespace input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\n  ")).toEqual([]);
  });

  it("drops fragments shorter than 40 characters", () => {
    expect(chunkMarkdown("short")).toEqual([]);
  });

  it("keeps a single paragraph that fits within maxChars as one chunk", () => {
    const para = "TeamViewer prefers outbound TCP and UDP port 5938 for all connections.";
    expect(chunkMarkdown(para)).toEqual([para]);
  });

  it("splits multiple paragraphs across chunks when they exceed maxChars", () => {
    const para = "x".repeat(800);
    const chunks = chunkMarkdown(`${para}\n\n${para}`, 1000);
    expect(chunks.length).toBe(2);
  });

  it("hard-splits a single oversized paragraph", () => {
    const huge = "y".repeat(3000);
    const chunks = chunkMarkdown(huge, 1000, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("returns 0 for mismatched lengths or empty/zero vectors", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});
