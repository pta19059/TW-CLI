import { describe, expect, it } from "vitest";
import { calculateConfidence, deduplicateActions } from "../src/mastra/workflows/teamviewerTroubleshootWorkflow.js";

describe("deduplicateActions", () => {
  it("removes duplicates by step text", () => {
    const out = deduplicateActions([
      { step: "A", risk: "low", rollback: "r1" },
      { step: "A", risk: "high", rollback: "r2" },
      { step: "B", risk: "low", rollback: "r3" }
    ]);
    expect(out.length).toBe(2);
    expect(out.find((a) => a.step === "A")?.risk).toBe("high");
  });
});

describe("calculateConfidence", () => {
  it("boosts on more evidence and troubleshoot task", () => {
    const score = calculateConfidence([{ title: "x", score: 0.6, rationale: "r" }], 5, "troubleshoot");
    expect(score).toBeGreaterThan(0.6);
    expect(score).toBeLessThanOrEqual(0.95);
  });
  it("caps at 0.95", () => {
    const score = calculateConfidence([{ title: "x", score: 0.99, rationale: "r" }], 50, "troubleshoot");
    expect(score).toBe(0.95);
  });
});
