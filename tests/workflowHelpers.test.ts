import { describe, expect, it } from "vitest";
import {
  calculateConfidence,
  cleanSummary,
  deduplicateActions,
  filterActionsAgainstEvidence,
  filterRootCausesAgainstEvidence
} from "../src/mastra/workflows/teamviewerTroubleshootWorkflow.js";

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

describe("cleanSummary", () => {
  it("keeps a normal one-line summary", () => {
    expect(cleanSummary("TeamViewer dropped due to firewall.")).toBe("TeamViewer dropped due to firewall.");
  });
  it("strips code fences and keeps first non-empty line", () => {
    expect(cleanSummary("```\nFirst line\nSecond line\n```")).toBe("First line");
  });
  it("rejects tool-call JSON shapes", () => {
    expect(cleanSummary('{"name": "teamviewerDocsTool", "arguments": {"query": "x"}}')).toBe("");
    expect(cleanSummary('{"function": "foo", "parameters": {}}')).toBe("");
  });
  it("rejects bare tool-id mentions", () => {
    expect(cleanSummary("call teamviewerDocsTool with query x")).toBe("");
  });
  it("rejects NOT_IN_CONTEXT marker", () => {
    expect(cleanSummary("NOT_IN_CONTEXT")).toBe("");
  });
  it("returns empty on empty / whitespace input", () => {
    expect(cleanSummary("")).toBe("");
    expect(cleanSummary("   \n\n  ")).toBe("");
  });
  it("skips prompt-label echo and returns the first prose line", () => {
    expect(cleanSummary("Task: troubleshoot\nThe service appears down on the Mac.")).toBe("The service appears down on the Mac.");
    expect(cleanSummary("Issue: TeamViewer drops\nProduct: teamviewer-remote\nA real prose summary here.")).toBe("A real prose summary here.");
  });
  it("returns empty when ALL lines are prompt-label echo", () => {
    expect(cleanSummary("Task: troubleshoot\nProduct: x\nConfidence: 0.20")).toBe("");
  });
  it("strips list bullets before evaluating", () => {
    expect(cleanSummary("- The session drops after a few minutes.")).toBe("The session drops after a few minutes.");
  });
});

describe("filterActionsAgainstEvidence", () => {
  const evidence5938Ok = [
    "Target scope: 192.168.1.153",
    "DNS resolved 6/6 TeamViewer hosts from 192.168.1.153",
    "TCP 5938 reachability: 3/3 routers OK",
    "HTTPS webapi probe: HTTP 200 in 1395ms",
    "All baseline connectivity probes succeeded."
  ];
  const evidenceHttpsFailedTcpOk = [
    "Target scope: 192.168.1.153",
    "DNS resolved 6/6 TeamViewer hosts from 192.168.1.153",
    "TCP 5938 reachability: 3/3 routers OK",
    "HTTPS webapi probe: failed (curl: (60) SSL certificate problem)",
    "TeamViewer Remote endpoint TCP reachability: 9/9 OK",
    "TeamViewer Remote HTTPS checks: 0/3 OK"
  ];
  it("drops firewall actions that mention the already-proven-open port 5938", () => {
    const out = filterActionsAgainstEvidence(
      [
        { step: "Check firewall settings for port 5938", risk: "low", rollback: "r" },
        { step: "Restart TeamViewer service", risk: "low", rollback: "r" }
      ],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
    expect(out[0].step).toMatch(/restart/i);
  });
  it("drops generic firewall-blocks-teamviewer actions when connectivity is healthy", () => {
    const out = filterActionsAgainstEvidence(
      [
        { step: "Check system settings for firewall rules blocking TeamViewer traffic.", risk: "low", rollback: "r" },
        { step: "Enable launchd plist", risk: "low", rollback: "r" }
      ],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
    expect(out[0].step).toMatch(/launchd/i);
  });
  it("drops generic firewall actions even when only DNS+TCP are OK (HTTPS may fail for non-firewall reasons)", () => {
    const out = filterActionsAgainstEvidence(
      [
        { step: "Check system settings for any firewall rules that might be blocking TeamViewer traffic.", risk: "low", rollback: "r" },
        { step: "Renew the macOS CA bundle", risk: "low", rollback: "r" }
      ],
      evidenceHttpsFailedTcpOk
    );
    expect(out.length).toBe(1);
    expect(out[0].step).toMatch(/CA bundle/i);
  });
  it("keeps non-firewall actions untouched", () => {
    const out = filterActionsAgainstEvidence(
      [{ step: "Restart the TeamViewer daemon", risk: "low", rollback: "r" }],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
  });
  it("does NOT filter when no connectivity evidence is present", () => {
    const out = filterActionsAgainstEvidence(
      [{ step: "Check firewall for port 5938", risk: "low", rollback: "r" }],
      ["Target scope: example.com"]
    );
    expect(out.length).toBe(1);
  });
});

describe("filterRootCausesAgainstEvidence", () => {
  const evidenceHttpsFailedTcpOk = [
    "DNS resolved 6/6 TeamViewer hosts from 192.168.1.153",
    "TCP 5938 reachability: 3/3 routers OK",
    "HTTPS webapi probe: failed (curl: (60) SSL certificate problem)",
    "TeamViewer Remote endpoint TCP reachability: 9/9 OK"
  ];
  it("drops firewall root causes when DNS+TCP prove connectivity is fine", () => {
    const out = filterRootCausesAgainstEvidence(
      [
        { title: "User's firewall blocking TeamViewer traffic", score: 0.6, rationale: "Firewall rules could be configured to block outgoing connections." },
        { title: "Expired CA bundle on macOS", score: 0.4, rationale: "Old root store fails to validate TeamViewer cert chain." }
      ],
      evidenceHttpsFailedTcpOk
    );
    expect(out.length).toBe(1);
    expect(out[0].title).toMatch(/CA bundle/i);
  });
  it("keeps non-firewall root causes untouched", () => {
    const out = filterRootCausesAgainstEvidence(
      [{ title: "TeamViewer Service not registered", score: 0.5, rationale: "launchctl shows no daemon" }],
      evidenceHttpsFailedTcpOk
    );
    expect(out.length).toBe(1);
  });
  it("does NOT filter when no connectivity evidence is present", () => {
    const out = filterRootCausesAgainstEvidence(
      [{ title: "Firewall blocking outgoing", score: 0.5, rationale: "..." }],
      ["Target scope: example.com"]
    );
    expect(out.length).toBe(1);
  });
});
