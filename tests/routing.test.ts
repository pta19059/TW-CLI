import { describe, expect, it } from "vitest";
import { inferIssueBuckets, selectAgents } from "../src/agents/routing.js";

describe("inferIssueBuckets", () => {
  it("detects connectivity keywords", () => {
    const buckets = inferIssueBuckets({ target: "x", issue: "dns lookup fails and packet loss on vpn" });
    expect(buckets).toContain("connectivity");
  });

  it("detects auth/policy keywords", () => {
    const buckets = inferIssueBuckets({ target: "x", issue: "user cannot login, sso token expired" });
    expect(buckets).toContain("auth-policy");
  });

  it("detects endpoint health keywords", () => {
    const buckets = inferIssueBuckets({ target: "x", issue: "service crash after version update" });
    expect(buckets).toContain("endpoint-health");
  });

  it("detects log intelligence keywords", () => {
    const buckets = inferIssueBuckets({ target: "x", issue: "exception trace in event log" });
    expect(buckets).toContain("log-intelligence");
  });

  it("falls back to generic", () => {
    const buckets = inferIssueBuckets({ target: "x", issue: "something weird happens" });
    expect(buckets).toEqual(["generic"]);
  });
});

describe("selectAgents", () => {
  it("always includes base and final agents", () => {
    const selected = selectAgents("troubleshoot", ["connectivity"]);
    expect(selected[0]).toBe("product-gatekeeper");
    expect(selected[selected.length - 1]).toBe("report");
    expect(selected).toContain("connectivity");
  });

  it("forces log-intelligence on debug", () => {
    const selected = selectAgents("debug", ["connectivity"]);
    expect(selected).toContain("log-intelligence");
  });
});
