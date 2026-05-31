import { describe, expect, it } from "vitest";
import {
  fromAuth,
  fromConnectivity,
  fromEndpointHealth,
  fromLogs
} from "../src/mastra/tools/specialistTools.js";
import type { ConnectivityReport } from "../src/probes/connectivity.js";
import type { EndpointHealthReport } from "../src/probes/endpointHealth.js";
import type { LogProbeReport } from "../src/probes/logs.js";
import type { AuthProbeReport } from "../src/probes/authPolicy.js";
import { normalize } from "../src/probes/logs.js";

describe("fromConnectivity", () => {
  it("flags DNS and TCP failures as root causes", () => {
    const report: ConnectivityReport = {
      dns: [
        { host: "router1.teamviewer.com", ok: true, addresses: ["1.2.3.4"], ms: 10 },
        { host: "router2.teamviewer.com", ok: false, error: "ENOTFOUND", ms: 20 }
      ],
      tcp5938: [{ host: "router1.teamviewer.com", port: 5938, ok: false, error: "timeout", ms: 3000 }],
      https: { url: "https://webapi.teamviewer.com/api/v1/ping", ok: false, error: "aborted", ms: 6000 }
    };
    const out = fromConnectivity(report, "vm-host");
    const titles = out.rootCauses.map((r) => r.title);
    expect(titles).toContain("DNS resolution failure for TeamViewer endpoints");
    expect(titles).toContain("TeamViewer primary port 5938 blocked or filtered");
    expect(titles).toContain("TeamViewer Web API unreachable over HTTPS");
    expect(out.actions.length).toBeGreaterThan(0);
  });

  it("reports clean when all probes succeed", () => {
    const report: ConnectivityReport = {
      dns: [{ host: "router1.teamviewer.com", ok: true, addresses: ["1.2.3.4"], ms: 10 }],
      tcp5938: [{ host: "router1.teamviewer.com", port: 5938, ok: true, ms: 50 }],
      https: { url: "https://webapi.teamviewer.com/api/v1/ping", ok: true, status: 200, ms: 120 }
    };
    const out = fromConnectivity(report, "vm-host");
    expect(out.rootCauses).toHaveLength(0);
    expect(out.evidence.join(" ")).toContain("All baseline connectivity probes succeeded.");
  });
});

describe("fromEndpointHealth", () => {
  it("detects a stopped service on Windows (install present via service)", () => {
    const report: EndpointHealthReport = {
      platform: "win32",
      osRelease: "10.0.22631",
      hostname: "vm-host",
      freeMemMb: 2048,
      totalMemMb: 8192,
      uptimeSec: 3600,
      services: [{ name: "TeamViewer_Service", status: "Stopped", startType: "Automatic" }],
      processes: [],
      installedVersion: "15.50.4",
      clientId: undefined,
      diagnostics: []
    };
    const out = fromEndpointHealth(report, "vm-host");
    const titles = out.rootCauses.map((r) => r.title);
    expect(titles).toContain("TeamViewer service not running");
    expect(titles).not.toContain("TeamViewer not installed / not detectable on target");
    expect(out.actions.some((a) => a.step.includes("Start-Service"))).toBe(true);
  });

  it("flags a fully-absent install when no service, process or version is found", () => {
    const report: EndpointHealthReport = {
      platform: "win32",
      osRelease: "10.0.22631",
      hostname: "vm-host",
      freeMemMb: 2048,
      totalMemMb: 8192,
      uptimeSec: 3600,
      services: [],
      processes: [],
      installedVersion: undefined,
      clientId: undefined,
      diagnostics: []
    };
    const out = fromEndpointHealth(report, "vm-host");
    expect(out.rootCauses.map((r) => r.title)).toContain("TeamViewer not installed / not detectable on target");
  });

  it("produces Linux-native remediation for a stopped teamviewerd", () => {
    const report: EndpointHealthReport = {
      platform: "linux",
      osRelease: "6.5.0-generic",
      hostname: "tv-linux",
      freeMemMb: 4096,
      totalMemMb: 16384,
      uptimeSec: 7200,
      services: [{ name: "teamviewerd", status: "inactive (dead)", startType: "enabled" }],
      processes: [],
      installedVersion: "15.51.5",
      clientId: "987654321",
      diagnostics: []
    };
    const out = fromEndpointHealth(report, "tv-linux");
    const titles = out.rootCauses.map((r) => r.title);
    expect(titles).toContain("TeamViewer service not running");
    expect(out.actions.some((a) => a.step.includes("systemctl enable --now teamviewerd"))).toBe(true);
  });

  it("uses launchctl remediation on macOS and reports the ClientID", () => {
    const report: EndpointHealthReport = {
      platform: "darwin",
      osRelease: "23.5.0",
      hostname: "tv-mac",
      freeMemMb: 8192,
      totalMemMb: 32768,
      uptimeSec: 9000,
      services: [],
      processes: [],
      installedVersion: undefined,
      clientId: "555000111",
      diagnostics: []
    };
    const out = fromEndpointHealth(report, "tv-mac");
    // ClientID present => install detected => "not installed" must NOT fire,
    // but the missing background service should be flagged with launchctl guidance.
    expect(out.rootCauses.map((r) => r.title)).not.toContain(
      "TeamViewer not installed / not detectable on target"
    );
    expect(out.evidence.join(" ")).toContain("ClientID 555000111");
    expect(out.actions.some((a) => a.step.includes("launchctl"))).toBe(true);
  });

  it("is clean when service runs and install present", () => {
    const report: EndpointHealthReport = {
      platform: "win32",
      osRelease: "10.0.22631",
      hostname: "vm-host",
      freeMemMb: 2048,
      totalMemMb: 8192,
      uptimeSec: 3600,
      services: [{ name: "TeamViewer_Service", status: "Running", startType: "Automatic" }],
      processes: ["TeamViewer", "TeamViewer_Service"],
      installedVersion: "15.50.4",
      clientId: "123456789",
      diagnostics: []
    };
    const out = fromEndpointHealth(report, "vm-host");
    expect(out.rootCauses).toHaveLength(0);
    expect(out.evidence.join(" ")).toContain("version 15.50.4");
  });
});

describe("fromLogs", () => {
  it("promotes a recurring signature to a root cause", () => {
    const report: LogProbeReport = {
      filesInspected: ["C:/log/tv.log"],
      totalLines: 100,
      errorCount: 5,
      warningCount: 1,
      topSignatures: [
        { signature: "connect failed to <hex>", count: 5, exampleLine: "ERROR connect failed to 0x1a" }
      ],
      diagnostics: []
    };
    const out = fromLogs(report);
    expect(out.rootCauses.some((r) => r.title === "Recurring failure signature in TeamViewer logs")).toBe(true);
  });

  it("handles no log files gracefully", () => {
    const report: LogProbeReport = {
      filesInspected: [],
      totalLines: 0,
      errorCount: 0,
      warningCount: 0,
      topSignatures: [],
      diagnostics: ["No TeamViewer log files found in standard locations."]
    };
    const out = fromLogs(report);
    expect(out.rootCauses).toHaveLength(0);
    expect(out.evidence[0]).toContain("No TeamViewer log files found");
  });
});

describe("fromAuth", () => {
  it("returns a hint when token is absent", () => {
    const report: AuthProbeReport = { tokenPresent: false, diagnostics: ["TEAMVIEWER_API_TOKEN not set"] };
    const out = fromAuth(report);
    expect(out.rootCauses).toHaveLength(0);
    expect(out.actions[0].step).toContain("TEAMVIEWER_API_TOKEN");
  });

  it("flags rejected token as a root cause", () => {
    const report: AuthProbeReport = {
      tokenPresent: true,
      pingOk: true,
      pingStatus: 200,
      accountOk: false,
      accountStatus: 401,
      diagnostics: []
    };
    const out = fromAuth(report);
    expect(out.rootCauses.some((r) => r.title.includes("token rejected") || r.title.includes("insufficient scopes"))).toBe(
      true
    );
  });

  it("matches the --target VM among managed devices and flags it when offline", () => {
    const report: AuthProbeReport = {
      tokenPresent: true,
      pingOk: true,
      pingStatus: 200,
      accountOk: true,
      accountStatus: 200,
      accountName: "Demo User",
      devicesCount: 2,
      devices: [
        { name: "office-pc", online: true },
        { name: "vm-twc-demo", online: false }
      ],
      diagnostics: []
    };
    const out = fromAuth(report, "vm-twc-demo");
    expect(out.evidence.join(" ")).toContain("Managed devices:");
    expect(out.evidence.join(" ")).toContain("vm-twc-demo");
    expect(out.rootCauses.some((r) => r.title === "Target device enrolled but offline")).toBe(true);
  });

  it("notes when the target is not enrolled in the account", () => {
    const report: AuthProbeReport = {
      tokenPresent: true,
      pingOk: true,
      pingStatus: 200,
      accountOk: true,
      accountStatus: 200,
      accountName: "Demo User",
      devicesCount: 1,
      devices: [{ name: "office-pc", online: true }],
      diagnostics: []
    };
    const out = fromAuth(report, "vm-twc-demo");
    expect(out.evidence.join(" ")).toContain("not found among managed devices");
    expect(out.rootCauses).toHaveLength(0);
  });
});

describe("log normalize()", () => {
  it("collapses timestamps, hex and numeric ids into one signature", () => {
    const a = normalize("2026-05-29 12:00:01.123 ERROR session 998877 failed 0xDEADBEEF");
    const b = normalize("2026-05-28 09:15:42.999 ERROR session 112233 failed 0xCAFEBABE");
    expect(a).toBe(b);
  });

  it("preserves the distinguishing message text", () => {
    const sig = normalize("2026-05-29 12:00:01 ERROR handshake timeout");
    expect(sig).toContain("ERROR handshake timeout");
    expect(sig).toContain("<date>");
    expect(sig).toContain("<time>");
  });
});
