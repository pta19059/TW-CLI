import { describe, it, expect } from "vitest";
import {
  referenceRelevance,
  isRelevantReference,
  type KnowledgeHit
} from "../src/knowledge/teamviewerDocs.js";

// Query mirrors the kind of issue+topic string the workflow builds:
//   `${def.topic} ${issue}` → "network reachability ... TeamViewer drops every few minutes"
const QUERY =
  "network reachability connectivity TeamViewer connection drops every few minutes network timeout";

const onTopic: KnowledgeHit = {
  kind: "doc",
  text:
    "When the TeamViewer connection drops every few minutes the cause is usually an " +
    "unstable network path or a NAT/firewall idle timeout closing the TCP session; " +
    "measure packet loss and check the timeout on port 5938.",
  score: 0.9,
  source: "https://community.teamviewer.com/connection-drops-network-timeout",
  title: "TeamViewer connection drops and network timeout",
  sem: 0.62
};

const offTopic: KnowledgeHit = {
  kind: "doc",
  text:
    "To deploy TeamViewer to cloned or imaged systems, reset the device identity and " +
    "use the mass deployment package so each clone registers as a unique device.",
  score: 0.88, // ranked high in a weak pool, but irrelevant to a connection-drop issue
  source: "https://community.teamviewer.com/clone-mass-deployment",
  title: "Use TeamViewer on cloned systems (mass deployment)",
  sem: 0.18
};

describe("KB reference relevance gate", () => {
  it("scores an on-topic page much higher than an off-topic one", () => {
    const onScore = referenceRelevance(QUERY, onTopic);
    const offScore = referenceRelevance(QUERY, offTopic);
    expect(onScore).toBeGreaterThan(offScore);
    // Clear separation, not a marginal one.
    expect(onScore - offScore).toBeGreaterThan(0.5);
  });

  it("admits the on-topic page as a citeable reference", () => {
    expect(isRelevantReference(QUERY, onTopic)).toBe(true);
  });

  it("rejects the off-topic page despite it ranking top-N in a weak pool", () => {
    expect(isRelevantReference(QUERY, offTopic)).toBe(false);
  });

  it("admits a semantically very-close page even with low keyword coverage", () => {
    const semClose: KnowledgeHit = {
      kind: "doc",
      text: "Intermittent session interruptions on long-lived links.",
      score: 0.7,
      source: "https://community.teamviewer.com/intermittent-sessions",
      title: "Intermittent session interruptions",
      sem: 0.7 // above the semantic escape-hatch floor (set above the embedder's TV cluster)
    };
    expect(isRelevantReference(QUERY, semClose)).toBe(true);
  });
});
