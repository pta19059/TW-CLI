import { describe, it, expect } from "vitest";
import { renderReportText, renderReportMarkdown } from "../src/agents/formatReport.js";
import type { WorkflowReport } from "../src/types.js";

function baseReport(overrides: Partial<WorkflowReport> = {}): WorkflowReport {
  return {
    summary: "Troubleshoot run",
    hypotheses: [],
    evidence: ["Target scope: local"],
    rootCauses: [],
    actions: [],
    confidence: 0.8,
    escalation: { required: false, reason: "ok" },
    execution: [],
    ...overrides
  };
}

describe("renderReport — related articles section", () => {
  const strong = { title: "Fix connectivity issues", source: "https://kb/connectivity", topic: "network", relevance: 0.72 };
  const related = { title: "Get started with Monitoring", source: "https://kb/monitoring", topic: "network", relevance: 0.45 };

  it("renders a separate RELATED ARTICLES section in the text report", () => {
    const out = renderReportText(baseReport({ references: [strong], relatedReferences: [related] }));
    expect(out).toContain("KNOWLEDGE BASE (supporting articles)");
    expect(out).toContain("RELATED ARTICLES");
    expect(out).toContain("Fix connectivity issues");
    expect(out).toContain("Get started with Monitoring");
    // The related article must appear AFTER the strong knowledge-base section.
    expect(out.indexOf("RELATED ARTICLES")).toBeGreaterThan(out.indexOf("KNOWLEDGE BASE"));
  });

  it("renders a Related Articles heading in the markdown report", () => {
    const out = renderReportMarkdown(baseReport({ references: [strong], relatedReferences: [related] }));
    expect(out).toContain("## Knowledge Base");
    expect(out).toContain("## Related Articles");
    expect(out).toContain("Get started with Monitoring");
  });

  it("omits the related section entirely when there are no related articles", () => {
    const out = renderReportText(baseReport({ references: [strong], relatedReferences: [] }));
    expect(out).not.toContain("RELATED ARTICLES");
  });
});
