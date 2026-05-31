import { describe, expect, it } from "vitest";
import { inferProduct, inferTarget, parseIntent } from "../src/agents/intent.js";
import { explainReport } from "../src/agents/explain.js";
import type { WorkflowReport } from "../src/types.js";

describe("inferProduct", () => {
  it("detects a product by alias", () => {
    expect(inferProduct("my tensor SSO login keeps failing")).toBe("teamviewer-tensor");
  });

  it("prefers the longer phrase (remote management over remote)", () => {
    expect(inferProduct("remote management monitoring agent stopped")).toBe("teamviewer-remote-management");
  });

  it("returns null when no product is mentioned", () => {
    expect(inferProduct("the screen is black and nothing works")).toBeNull();
  });
});

describe("inferTarget", () => {
  it("extracts a labelled target", () => {
    expect(inferTarget("cannot connect to device vm-twc-demo")).toBe("vm-twc-demo");
  });

  it("extracts an IPv4 address", () => {
    expect(inferTarget("partner at 10.0.0.4 is unreachable")).toBe("10.0.0.4");
  });

  it("extracts a hostname-like token", () => {
    expect(inferTarget("the host web-prod-01 dropped the session")).toBe("web-prod-01");
  });

  it("returns null when there is no obvious target", () => {
    expect(inferTarget("it just disconnects randomly")).toBeNull();
  });
});

describe("parseIntent", () => {
  it("returns both product and target when present", () => {
    const intent = parseIntent("tensor cannot reach device vm-twc-demo");
    expect(intent.product).toBe("teamviewer-tensor");
    expect(intent.target).toBe("vm-twc-demo");
  });
});

describe("explainReport", () => {
  const report: WorkflowReport = {
    summary: "TeamViewer service is stopped on the target.",
    hypotheses: [],
    evidence: ["Services: teamviewerd=Stopped"],
    rootCauses: [
      { title: "TeamViewer service not running", score: 0.85, rationale: "Stopped: teamviewerd=Stopped" }
    ],
    actions: [
      { step: "Start the service", risk: "low", rollback: "stop it", command: "sudo systemctl enable --now teamviewerd" }
    ],
    confidence: 0.8,
    escalation: { required: false, reason: "within automated scope" },
    execution: []
  };

  it("produces a plain-language narrative with the command", () => {
    const text = explainReport(report, { product: "teamviewer-remote", target: "vm-twc-demo", task: "troubleshoot" });
    expect(text).toContain("TeamViewer Remote");
    expect(text).toContain("vm-twc-demo");
    expect(text).toContain("85%");
    expect(text).toContain("sudo systemctl enable --now teamviewerd");
  });

  it("handles a clean report with no root causes", () => {
    const clean: WorkflowReport = { ...report, rootCauses: [], actions: [] };
    const text = explainReport(clean, { product: "teamviewer-remote", target: "host", task: "debug" });
    expect(text).toContain("none of the probes flagged");
  });
});
