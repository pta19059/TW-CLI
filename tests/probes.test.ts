import { describe, expect, it } from "vitest";
import {
  fromAuth,
  fromConnectivity,
  fromEndpointHealth,
  fromLogs
} from "../src/mastra/tools/specialistTools.js";
import type { ConnectivityReport } from "../src/probes/connectivity.js";
import { probeDnsHost, probeTcpHost, runConnectivityProbe } from "../src/probes/connectivity.js";
import type { EndpointHealthReport } from "../src/probes/endpointHealth.js";
import { runEndpointHealthProbe } from "../src/probes/endpointHealth.js";
import type { LogProbeReport } from "../src/probes/logs.js";
import type { AuthProbeReport } from "../src/probes/authPolicy.js";
import { normalize, runLogProbe } from "../src/probes/logs.js";
import { buildMacCaptureCommand, parseMacPowerEvents, parseWindowsPowerEvents, parseLinuxPowerEvents } from "../src/probes/logs.js";
import { getProductProfile } from "../src/catalog/productProfiles.js";
import { filterRootCausesAgainstEvidence } from "../src/mastra/workflows/teamviewerTroubleshootWorkflow.js";

describe("buildMacCaptureCommand", () => {
  it("builds a self-contained capture-then-grep pipeline for a window", () => {
    const cmd = buildMacCaptureCommand(120);
    expect(cmd).toContain("log stream");
    expect(cmd).toContain("--predicate");
    expect(cmd).toContain("mktemp");
    expect(cmd).toContain("sleep 120");
    expect(cmd).toContain("kill");
    expect(cmd).toMatch(/egrep|grep -E/);
    expect(cmd).toContain("rm -f");
  });

  it("floors the sleep window to at least 1 second", () => {
    const cmd = buildMacCaptureCommand(0);
    expect(cmd).toContain("sleep 1");
  });

  it("filters for failure-related keywords", () => {
    const cmd = buildMacCaptureCommand(30);
    expect(cmd.toLowerCase()).toMatch(/disconnect|drop|timeout|reconnect/);
  });
});

describe("parseMacPowerEvents", () => {
  const sample = [
    "===PMSET===",
    "System-wide power settings:",
    "Currently in use:",
    " standby              1",
    " powernap             0",
    " sleep                0",
    " tcpkeepalive         1",
    " standbydelaylow      10800",
    " hibernatefile        /var/vm/sleepimage",
    " womp                 1",
    "===EVENTS===",
    "2026-06-08 15:53:27.867 Df TeamViewer_Service NetWatchdog: OnStandby going to sleep",
    "2026-06-08 15:53:27.867 Df TeamViewer_Service NetWatchdog: Completely disconnected. Going offline",
    "2026-06-08 19:12:33.790 Df TeamViewer_Service NetWatchdog: OnStandby woke up",
    "2026-06-08 20:19:05.824 Df TeamViewer_Service NetWatchdog: OnStandby going to sleep",
    "2026-06-08 20:19:05.824 Df TeamViewer_Service NetWatchdog: Completely disconnected. Going offline",
    "2026-06-08 20:19:21.462 Df TeamViewer_Service NetWatchdog: OnStandby woke up"
  ].join("\n");

  it("counts standby disconnects, enters and wake recoveries", () => {
    const p = parseMacPowerEvents(sample);
    expect(p.standbyDisconnects).toBe(2);
    expect(p.standbyEnters).toBe(2);
    expect(p.wakeRecoveries).toBe(2);
    expect(p.disconnectTimes).toEqual(["2026-06-08 15:53:27", "2026-06-08 20:19:05"]);
  });

  it("parses pmset flags (standby on, powernap off, sleep disabled, tcpkeepalive on)", () => {
    const p = parseMacPowerEvents(sample);
    expect(p.standbyEnabled).toBe(true);
    expect(p.powerNapEnabled).toBe(false);
    expect(p.sleepDisabled).toBe(true);
    expect(p.tcpKeepAlive).toBe(true);
    expect(p.standbyDelayLowSec).toBe(10800);
    expect(p.pmsetSummary).toContain("standby=1");
    expect(p.pmsetSummary).toContain("powernap=0");
  });

  it("returns zero counts and undefined flags when nothing matches", () => {
    const p = parseMacPowerEvents("===PMSET===\n===EVENTS===\n");
    expect(p.standbyDisconnects).toBe(0);
    expect(p.standbyEnabled).toBeUndefined();
    expect(p.pmsetSummary).toBeUndefined();
  });
});

describe("parseWindowsPowerEvents", () => {
  const sample = [
    "===CONFIG===",
    "sleep_supported=1",
    "standby_timeout_ac_sec=1800",
    "standby_timeout_dc_sec=600",
    "===EVENTS===",
    "2026-06-08 15:53:27 Id=42",
    "2026-06-08 16:10:02 Id=107",
    "2026-06-08 20:19:05 Id=506",
    "2026-06-08 20:25:11 Id=507",
    "2026-06-08 21:35:56 Id=42",
    "2026-06-08 21:40:00 Id=1"
  ].join("\n");

  it("counts Kernel-Power sleep-enter (42/506) as disconnects and resume (107/507/1) as recoveries", () => {
    const p = parseWindowsPowerEvents(sample);
    expect(p.os).toBe("windows");
    expect(p.standbyDisconnects).toBe(3);
    expect(p.standbyEnters).toBe(3);
    expect(p.wakeRecoveries).toBe(3);
    expect(p.disconnectTimes).toEqual([
      "2026-06-08 15:53:27",
      "2026-06-08 20:19:05",
      "2026-06-08 21:35:56"
    ]);
  });

  it("parses powercfg standby timeouts and derives sleep flags", () => {
    const p = parseWindowsPowerEvents(sample);
    expect(p.standbyEnabled).toBe(true);
    expect(p.sleepDisabled).toBe(false);
    expect(p.standbyDelayLowSec).toBe(1800);
    expect(p.powercfgSummary).toContain("standby-timeout(AC)=1800s");
    expect(p.powercfgSummary).toContain("sleep supported");
  });

  it("treats AC standby-timeout=0 as sleep disabled", () => {
    const p = parseWindowsPowerEvents(
      "===CONFIG===\nstandby_timeout_ac_sec=0\n===EVENTS===\n"
    );
    expect(p.sleepDisabled).toBe(true);
    expect(p.standbyEnabled).toBe(false);
    expect(p.powercfgSummary).toContain("(never)");
  });

  it("returns zero counts and undefined flags when nothing matches", () => {
    const p = parseWindowsPowerEvents("===CONFIG===\n===EVENTS===\n");
    expect(p.standbyDisconnects).toBe(0);
    expect(p.standbyEnabled).toBeUndefined();
    expect(p.powercfgSummary).toBeUndefined();
  });
});

describe("parseLinuxPowerEvents", () => {
  const sample = [
    "===CONFIG===",
    "suspend_masked=0",
    "===EVENTS===",
    "2026-06-08T15:53:27 host systemd-logind[1]: System is suspending. SUSPEND",
    "2026-06-08T19:12:33 host systemd-logind[1]: System resumed. RESUME",
    "2026-06-08T20:19:05 host kernel: PM: suspend entry SUSPEND",
    "2026-06-08T20:25:11 host kernel: PM: suspend exit RESUME"
  ].join("\n");

  it("counts suspend transitions as disconnects and resumes as recoveries", () => {
    const p = parseLinuxPowerEvents(sample);
    expect(p.os).toBe("linux");
    expect(p.standbyDisconnects).toBe(2);
    expect(p.standbyEnters).toBe(2);
    expect(p.wakeRecoveries).toBe(2);
    expect(p.disconnectTimes).toEqual(["2026-06-08 15:53:27", "2026-06-08 20:19:05"]);
  });

  it("derives sleep flags from suspend_masked", () => {
    const p = parseLinuxPowerEvents(sample);
    expect(p.standbyEnabled).toBe(true);
    expect(p.sleepDisabled).toBe(false);
    expect(p.powercfgSummary).toContain("suspend available");
  });

  it("treats suspend_masked=1 as sleep disabled", () => {
    const p = parseLinuxPowerEvents("===CONFIG===\nsuspend_masked=1\n===EVENTS===\n");
    expect(p.sleepDisabled).toBe(true);
    expect(p.standbyEnabled).toBe(false);
    expect(p.powercfgSummary).toContain("masked");
  });

  it("returns zero counts when nothing matches", () => {
    const p = parseLinuxPowerEvents("===CONFIG===\n===EVENTS===\n");
    expect(p.standbyDisconnects).toBe(0);
    expect(p.standbyEnabled).toBeUndefined();
  });
});

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

  it("emits a DNS-specific action when the dominant signature is a resolve failure", () => {
    const report: LogProbeReport = {
      filesInspected: ["<macOS unified log>"],
      totalLines: 666,
      errorCount: 613,
      warningCount: 26,
      topSignatures: [
        {
          signature: "HttpRequestImplCurl[<hex>]::CurlFinished(): curl request failed: Could not resolve hostname (6), Could not resolve host: router11.teamviewer.com",
          count: 102,
          exampleLine: "E TeamViewer_Service ... CurlFinished(): curl request failed: Could not resolve hostname (6), Could not resolve host: router11.teamviewer.com"
        }
      ],
      diagnostics: []
    };
    const out = fromLogs(report);
    const action = out.actions.map((a) => a.step).join("\n").toLowerCase();
    expect(action).toContain("dns");
    expect(action).toMatch(/scutil|dscacheutil|resolvectl|dig/);
    expect(action).not.toContain("triage the dominant signature");
  });

  it("emits a TLS-specific action when the dominant signature is a handshake failure", () => {
    const report: LogProbeReport = {
      filesInspected: ["<macOS unified log>"],
      totalLines: 100, errorCount: 80, warningCount: 5,
      topSignatures: [
        { signature: "SSL handshake failed: certificate verify failed", count: 12, exampleLine: "TLS handshake failed: certificate verify failed (self-signed)" }
      ],
      diagnostics: []
    };
    const out = fromLogs(report);
    const action = out.actions.map((a) => a.step).join("\n").toLowerCase();
    expect(action).toMatch(/tls|handshake|ca bundle|certificate/);
    expect(action).toContain("clock");
  });

  it("emits a timeout-specific action when the dominant signature is a connection drop", () => {
    const report: LogProbeReport = {
      filesInspected: ["<macOS unified log>"],
      totalLines: 200, errorCount: 150, warningCount: 20,
      topSignatures: [
        { signature: "NetWatchdog: Completely disconnected, connection timed out after 55 seconds", count: 22, exampleLine: "NetWatchdog: Completely disconnected, connection timed out after 55 seconds" }
      ],
      diagnostics: []
    };
    const out = fromLogs(report);
    const action = out.actions.map((a) => a.step).join("\n").toLowerCase();
    expect(action).toMatch(/ping|tcpdump|traceroute|mtr/);
  });

  it("routes TeamViewer RetryHandle/RCommand resend storms to the transport-instability action", () => {
    const report: LogProbeReport = {
      filesInspected: ["<macOS unified log>"],
      totalLines: 96, errorCount: 58, warningCount: 16,
      topSignatures: [
        {
          signature: "RetryHandle::HandleRetry(): Trying resend to 13 failed with error RCommand:1, retrying (2 retries remaining) BCmd: CC=0 CT=0",
          count: 8,
          exampleLine: "Df TeamViewer_Service ... RetryHandle::HandleRetry(): Trying resend to 13 failed with error RCommand:1, retrying (2 retries remaining) BCmd: CC=0 CT=0"
        }
      ],
      diagnostics: []
    };
    const out = fromLogs(report);
    const action = out.actions.map((a) => a.step).join("\n").toLowerCase();
    expect(action).toContain("transport");
    expect(action).toMatch(/ping|tcpdump|traceroute|mtr/);
    expect(action).not.toContain("triage the dominant signature");
  });

  it("surfaces a macOS standby root cause when NetWatchdog logged standby disconnects", () => {
    const report: LogProbeReport = {
      filesInspected: ["<macOS unified log>"],
      totalLines: 96, errorCount: 58, warningCount: 16,
      topSignatures: [
        {
          signature: "RetryHandle::HandleRetry(): Trying resend to 13 failed with error RCommand:1, retrying",
          count: 8,
          exampleLine: "Df TeamViewer_Service ... RetryHandle::HandleRetry(): Trying resend to 13 failed with error RCommand:1, retrying"
        }
      ],
      diagnostics: [],
      power: {
        standbyDisconnects: 4,
        standbyEnters: 4,
        wakeRecoveries: 4,
        disconnectTimes: ["2026-06-08 15:53:27", "2026-06-08 19:12:33", "2026-06-08 20:19:05", "2026-06-08 21:35:56"],
        standbyEnabled: true,
        powerNapEnabled: false,
        tcpKeepAlive: true,
        standbyDelayLowSec: 10800,
        pmsetSummary: "sleep=0, standby=1, powernap=0, tcpkeepalive=1, standbydelaylow=10800"
      }
    };
    const out = fromLogs(report);
    const standby = out.rootCauses.find((r) => /standby|sleep/i.test(r.title));
    expect(standby).toBeDefined();
    // The standby cause must OUTRANK the demoted RetryHandle signature.
    const retry = out.rootCauses.find((r) => /recurring failure signature/i.test(r.title));
    expect(retry).toBeDefined();
    expect(standby!.score).toBeGreaterThan(retry!.score);
    // The RetryHandle signature is demoted to reconnection noise.
    expect(retry!.score).toBeLessThan(0.5);
    expect(retry!.rationale.toLowerCase()).toContain("reconnection aftermath");
    // The transport action is reframed (standby-aware), not the generic one.
    const action = out.actions.map((a) => a.step).join("\n").toLowerCase();
    expect(action).toMatch(/standby|caffeinate|pmset|prevent system from sleeping/);
  });

  it("surfaces a Windows standby root cause when Kernel-Power logged sleep/resume events", () => {
    const report: LogProbeReport = {
      filesInspected: ["C:/ProgramData/TeamViewer/Logs/TeamViewer15_Logfile.log"],
      totalLines: 88, errorCount: 40, warningCount: 12,
      topSignatures: [
        {
          signature: "RetryHandle::HandleRetry(): Trying resend to 13 failed with error RCommand:1, retrying",
          count: 7,
          exampleLine: "TeamViewer_Service ... RetryHandle::HandleRetry(): Trying resend to 13 failed with error RCommand:1, retrying"
        }
      ],
      diagnostics: [],
      power: {
        os: "windows",
        standbyDisconnects: 3,
        standbyEnters: 3,
        wakeRecoveries: 3,
        disconnectTimes: ["2026-06-08 15:53:27", "2026-06-08 20:19:05", "2026-06-08 21:35:56"],
        standbyEnabled: true,
        standbyDelayLowSec: 1800,
        powercfgSummary: "sleep supported, standby-timeout(AC)=1800s, standby-timeout(DC)=600s"
      }
    };
    const out = fromLogs(report);
    const standby = out.rootCauses.find((r) => /windows standby|sleep/i.test(r.title));
    expect(standby).toBeDefined();
    expect(standby!.title).toMatch(/windows standby/i);
    // The standby cause must OUTRANK the demoted RetryHandle signature.
    const retry = out.rootCauses.find((r) => /recurring failure signature/i.test(r.title));
    expect(retry).toBeDefined();
    expect(standby!.score).toBeGreaterThan(retry!.score);
    expect(retry!.score).toBeLessThan(0.5);
    // Windows-flavored remediation + evidence (powercfg / Kernel-Power), not pmset.
    const action = out.actions.map((a) => a.step).join("\n").toLowerCase();
    expect(action).toMatch(/powercfg|standby-timeout|prevent system from sleeping/);
    expect(action).not.toMatch(/pmset|caffeinate/);
    const evidence = out.evidence.join("\n");
    expect(evidence).toMatch(/Kernel-Power/);
    expect(evidence).toMatch(/powercfg/);
  });

  it("demotes a license/CMML signature as reconnection noise when standby is the proven cause", () => {
    const report: LogProbeReport = {
      filesInspected: ["<macOS unified log>"],
      totalLines: 134, errorCount: 75, warningCount: 22,
      topSignatures: [
        {
          signature: "TAF::CMML: ValidHours=2, TimeOut=<num> ms",
          count: 8,
          exampleLine: "Df TeamViewer[467:178f] [com.teamviewer.TeamViewer:-G501-3] TAF::CMML: ValidHours=2, TimeOut=20000 ms"
        }
      ],
      diagnostics: [],
      power: {
        standbyDisconnects: 3,
        standbyEnters: 3,
        wakeRecoveries: 3,
        disconnectTimes: ["2026-06-08 15:53:27", "2026-06-08 20:19:05", "2026-06-08 21:35:56"],
        standbyEnabled: true,
        powerNapEnabled: false,
        tcpKeepAlive: true,
        standbyDelayLowSec: 10800,
        pmsetSummary: "sleep=0, standby=1, powernap=0, tcpkeepalive=1, standbydelaylow=10800"
      }
    };
    const out = fromLogs(report);
    const standby = out.rootCauses.find((r) => /standby|sleep/i.test(r.title));
    const sig = out.rootCauses.find((r) => /recurring failure signature/i.test(r.title));
    expect(standby).toBeDefined();
    expect(sig).toBeDefined();
    // The license/CMML burst at wake is demoted below standby (it is the same
    // reconnection aftermath, just a different subsystem than RetryHandle).
    expect(sig!.score).toBeLessThan(0.5);
    expect(sig!.rationale.toLowerCase()).toContain("reconnection aftermath");
    expect(standby!.score).toBeGreaterThan(sig!.score);
  });

  it("rules out idle-sleep when pmset is present but no standby disconnects occurred", () => {
    const report: LogProbeReport = {
      filesInspected: ["<macOS unified log>"],
      totalLines: 50, errorCount: 0, warningCount: 0,
      topSignatures: [],
      diagnostics: [],
      power: {
        standbyDisconnects: 0,
        standbyEnters: 0,
        wakeRecoveries: 0,
        disconnectTimes: [],
        standbyEnabled: false,
        pmsetSummary: "sleep=0, standby=0"
      }
    };
    const out = fromLogs(report);
    expect(out.rootCauses.some((r) => /standby|sleep/i.test(r.title))).toBe(false);
    expect(out.evidence.join("\n").toLowerCase()).toContain("idle-sleep is ruled out");
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

  it("collapses macOS unified-log lines that differ only by [pid:tid] thread-id", () => {
    // Real-shape lines from TeamViewer 15 on macOS Monterey. These four lines
    // describe identical DNS resolution failures but use four different
    // thread ids — the old normalize() leaked "99:158b" → "<time>8b" so they
    // clustered as four signatures instead of one.
    const lines = [
      `2026-06-07 15:47:54.426 E  TeamViewer_Service[99:158b] [com.teamviewer.TeamViewer:-S0-5] HttpRequestImplCurl[0x7f9f6b04d800]::CurlFinished(): curl request failed: Could not resolve hostname (6), Could not resolve host: router11.teamviewer.com`,
      `2026-06-07 15:48:12.811 E  TeamViewer_Service[99:158a] [com.teamviewer.TeamViewer:-S0-5] HttpRequestImplCurl[0x7f9f6b04d900]::CurlFinished(): curl request failed: Could not resolve hostname (6), Could not resolve host: router11.teamviewer.com`,
      `2026-06-07 15:49:01.118 E  TeamViewer_Service[99:1589] [com.teamviewer.TeamViewer:-S0-5] HttpRequestImplCurl[0x7f9f6b04da00]::CurlFinished(): curl request failed: Could not resolve hostname (6), Could not resolve host: router11.teamviewer.com`,
      `2026-06-07 15:50:33.005 E  TeamViewer_Service[99:158c] [com.teamviewer.TeamViewer:-S0-5] HttpRequestImplCurl[0x7f9f6b04db00]::CurlFinished(): curl request failed: Could not resolve hostname (6), Could not resolve host: router11.teamviewer.com`
    ];
    const sigs = new Set(lines.map(normalize));
    expect(sigs.size).toBe(1);
    const sig = [...sigs][0];
    expect(sig).toContain("CurlFinished");
    expect(sig).toContain("Could not resolve hostname");
    // The os_log boilerplate must be stripped, not present as "<time>8b".
    expect(sig).not.toMatch(/<time>[0-9a-f]/);
    expect(sig).not.toContain("TeamViewer_Service[");
    expect(sig).not.toContain("[com.teamviewer.TeamViewer");
  });

  it("does NOT mistake a bare hex/colon thread-id token for a clock time", () => {
    // Without leading whitespace the time regex must NOT collapse "99:158b".
    // (The macOS prefix stripper covers the real shape; this guards the
    //  fallback time regex against eating thread ids inside payload text.)
    const sig = normalize("payload contains tag(99:158b) somewhere");
    expect(sig).toContain("(99:158b)");
    expect(sig).not.toMatch(/<time>[0-9a-f]/);
  });
});

describe("remote connectivity probes are OS-aware (Windows)", () => {
  // Minimal fake context that records the command it was asked to run and
  // returns a canned ShellResult. ctx.os drives which command set the probe
  // emits, exactly like a real SshContext to a Windows host.
  function fakeWinCtx(stdout: string) {
    const commands: string[] = [];
    const ctx = {
      kind: "ssh" as const,
      os: "windows" as const,
      description: "ssh user@win",
      async runShell(command: string) {
        commands.push(command);
        return { stdout, stderr: "", exitCode: 0, ms: 1 };
      },
      async readFile() { return ""; },
      async listDir() { return []; },
      async pathExists() { return false; }
    };
    return { ctx, commands };
  }

  it("resolves DNS via .NET [System.Net.Dns], never POSIX getent/dig", async () => {
    const { ctx, commands } = fakeWinCtx("93.184.216.34");
    const res = await probeDnsHost("login.teamviewer.com", ctx as any);
    expect(commands[0]).toContain("System.Net.Dns");
    expect(commands[0]).not.toContain("getent");
    expect(commands[0]).not.toContain("dig ");
    expect(res.ok).toBe(true);
    expect(res.addresses).toContain("93.184.216.34");
  });

  it("probes TCP via a .NET TcpClient and __ok__ sentinel, never POSIX nc", async () => {
    const { ctx, commands } = fakeWinCtx("__ok__");
    const res = await probeTcpHost("router1.teamviewer.com", 5938, 3000, ctx as any);
    expect(commands[0]).toContain("Net.Sockets.TcpClient");
    expect(commands[0]).not.toMatch(/\bnc -z\b/);
    expect(res.ok).toBe(true);
  });

  it("reports a TCP failure when the sentinel is __fail__", async () => {
    const { ctx } = fakeWinCtx("connection timed out\n__fail__");
    const res = await probeTcpHost("router1.teamviewer.com", 5938, 3000, ctx as any);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/i);
  });
});

describe("Windows connectivity probes are BATCHED (one SSH+PowerShell per category)", () => {
  // Every ssh→powershell.exe round-trip on a Windows target pays a 3–5s cold
  // start, so runConnectivityProbe must collapse all DNS/TCP/HTTPS probes into
  // ONE invocation each instead of a 20-way concurrent storm (which blew the
  // per-probe timeout during PowerShell startup → flaky false "unreachable").
  function fakeWinBatchCtx() {
    const commands: string[] = [];
    const pick = (cmd: string, marker: RegExp) => {
      const m = cmd.match(marker);
      if (!m) return [] as string[];
      return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    const ctx = {
      kind: "ssh" as const,
      os: "windows" as const,
      description: "ssh user@win",
      async runShell(command: string) {
        commands.push(command);
        let stdout = "";
        if (command.includes("__DNS__")) {
          stdout = pick(command, /\$targets=@\(([^)]*)\)/)
            .map((h) => `__DNS__|${h}|93.184.216.34`)
            .join("\n");
        } else if (command.includes("__TCP__")) {
          stdout = pick(command, /\$pairs=@\(([^)]*)\)/)
            .map((p) => {
              const i = p.lastIndexOf(":");
              return `__TCP__|${p.slice(0, i)}|${p.slice(i + 1)}|OK`;
            })
            .join("\n");
        } else if (command.includes("__HTTPS__")) {
          stdout = pick(command, /\$urls=@\(([^)]*)\)/)
            .map((u) => `__HTTPS__|${u}|0|200`)
            .join("\n");
        }
        return { stdout, stderr: "", exitCode: 0, ms: 1 };
      },
      async readFile() { return ""; },
      async listDir() { return []; },
      async pathExists() { return false; }
    };
    return { ctx, commands };
  }

  it("issues exactly ONE DNS, ONE TCP and ONE HTTPS PowerShell call for the whole product", async () => {
    const { ctx, commands } = fakeWinBatchCtx();
    const report = await runConnectivityProbe(getProductProfile("teamviewer-remote"), ctx as any);
    expect(commands.filter((c) => c.includes("__DNS__")).length).toBe(1);
    expect(commands.filter((c) => c.includes("__TCP__")).length).toBe(1);
    expect(commands.filter((c) => c.includes("__HTTPS__")).length).toBe(1);
    // teamviewer-remote has 12 TCP endpoint/port pairs — all must be reported
    // from that single batched call, not 12 separate SSH connections.
    const allTcp = [...report.tcp5938, ...(report.tcpExtra ?? [])];
    expect(allTcp.length).toBeGreaterThanOrEqual(12);
    expect(allTcp.every((t) => t.ok)).toBe(true);
    expect(report.https.ok).toBe(true);
    expect(report.https.status).toBe(200);
  });

  it("never emits the misleading 'curl failed' string on Windows", async () => {
    const { ctx, commands } = fakeWinBatchCtx();
    await runConnectivityProbe(getProductProfile("teamviewer-remote"), ctx as any);
    expect(commands.some((c) => /curl/i.test(c))).toBe(false);
  });
});

describe("Windows log discovery looks in the TeamViewer INSTALL dir", () => {
  it("searches C:\\Program Files\\TeamViewer where TeamViewer15_Logfile.log / TVNetwork.log live", async () => {
    const commands: string[] = [];
    const ctx = {
      kind: "ssh" as const,
      os: "windows" as const,
      description: "ssh user@win",
      async runShell(command: string) {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0, ms: 1 };
      },
      async readFile() { return ""; },
      async listDir() { return []; },
      async pathExists() { return false; }
    };
    await runLogProbe(getProductProfile("teamviewer-remote"), ctx as any);
    expect(commands.some((c) => c.includes("ProgramFiles\\TeamViewer"))).toBe(true);
    expect(commands.some((c) => c.includes("LOCALAPPDATA\\TeamViewer"))).toBe(true);
  });
});

describe("TeamViewer log file pattern matches the real Windows log names", () => {
  const pat = getProductProfile("teamviewer-remote").logFilePattern;
  it("matches TeamViewer15_Logfile.log and TVNetwork.log", () => {
    expect(pat.test("TeamViewer15_Logfile.log")).toBe(true);
    expect(pat.test("TeamViewer15_Hooks.log")).toBe(true);
    expect(pat.test("TVNetwork.log")).toBe(true);
  });
  it("rejects the LevelDB / browser-control noise under %LOCALAPPDATA%", () => {
    expect(pat.test("000003.log")).toBe(false);
    expect(pat.test("favorites_diagnostic.log")).toBe(false);
  });
});

describe("filterRootCausesAgainstEvidence drops management-plane misattributions when the backbone is healthy", () => {
  it("drops 'endpoint unreachable' / 'Web API unreachable' for webapi when DNS + 5938 are fully OK", () => {
    const evidence = [
      "DNS resolved 6/6 TeamViewer hosts from 192.168.1.104",
      "TCP 5938 reachability: 3/3 routers OK",
      "TeamViewer Remote endpoint TCP reachability: 9/9 OK"
    ];
    const roots = [
      { title: "TeamViewer Remote endpoint unreachable", score: 0.8, rationale: "Cannot reach webapi.teamviewer.com:443" },
      { title: "TeamViewer Web API unreachable over HTTPS", score: 0.7, rationale: "request timed out" }
    ];
    const out = filterRootCausesAgainstEvidence(roots, evidence);
    expect(out).toHaveLength(0);
  });

  it("KEEPS the endpoint-unreachable cause when port 5938 is actually blocked", () => {
    const evidence = [
      "DNS resolved 6/6 TeamViewer hosts from 192.168.1.104",
      "TCP 5938 reachability: 0/3 routers OK",
      "TCP 5938 blocked for: router1.teamviewer.com (timeout)"
    ];
    const roots = [
      { title: "TeamViewer Remote endpoint unreachable", score: 0.8, rationale: "Cannot reach webapi.teamviewer.com:443" }
    ];
    const out = filterRootCausesAgainstEvidence(roots, evidence);
    expect(out).toHaveLength(1);
  });

  it("KEEPS the endpoint-unreachable cause when a session host (router) is also blocked", () => {
    const evidence = [
      "DNS resolved 6/6 TeamViewer hosts from 192.168.1.104",
      "TCP 5938 reachability: 3/3 routers OK"
    ];
    const roots = [
      {
        title: "TeamViewer Remote endpoint unreachable",
        score: 0.8,
        rationale: "Cannot reach router1.teamviewer.com:443, webapi.teamviewer.com:443"
      }
    ];
    const out = filterRootCausesAgainstEvidence(roots, evidence);
    expect(out).toHaveLength(1);
  });
});

describe("Windows endpoint-health probe tolerates noisy SSH exit codes and maps service enums", () => {
  // Get-Service over SSH returns exit code 1 whenever ANY requested name is
  // absent (e.g. "TeamViewer_Service" is a process, not a service), yet the
  // JSON for services that DO exist is still emitted. The probe must parse it
  // and map the numeric Status/StartType enums to human-readable labels.
  function fakeWinHealthCtx() {
    const ctx = {
      kind: "ssh" as const,
      os: "windows" as const,
      description: "ssh user@win",
      async runShell(command: string) {
        if (command.includes("Get-Service")) {
          // exit code 1, but valid single-object JSON for the one real service
          return {
            stdout: '{"Name":"TeamViewer","Status":4,"StartType":2}',
            stderr: "",
            exitCode: 1,
            ms: 1
          };
        }
        if (command.includes("Get-Process")) {
          return { stdout: "TeamViewer\nTeamViewer_Service\ntv_w32\ntv_x64", stderr: "", exitCode: 1, ms: 1 };
        }
        if (command.includes("Get-ItemProperty")) {
          return { stdout: '{"Version":"15.78.4","ClientID":1637297536}', stderr: "", exitCode: 1, ms: 1 };
        }
        // host-info / anything else
        return { stdout: "", stderr: "", exitCode: 0, ms: 1 };
      },
      async readFile() { return ""; },
      async listDir() { return []; },
      async pathExists() { return false; }
    };
    return ctx;
  }

  it("reports the TeamViewer service even when Get-Service exits non-zero, with a 'Running' label", async () => {
    const report = await runEndpointHealthProbe(getProductProfile("teamviewer-remote"), fakeWinHealthCtx() as any);
    const tv = report.services.find((s) => s.name === "TeamViewer");
    expect(tv).toBeDefined();
    expect(tv?.status).toBe("Running");
    expect(tv?.startType).toBe("Automatic");
  });

  it("still parses processes and registry version/clientId despite exit code 1", async () => {
    const report = await runEndpointHealthProbe(getProductProfile("teamviewer-remote"), fakeWinHealthCtx() as any);
    expect(report.processes).toContain("TeamViewer");
    expect(report.processes).toContain("tv_x64");
    expect(report.installedVersion).toBe("15.78.4");
    expect(report.clientId).toBe("1637297536");
  });
});

describe("Windows log discovery emits a REAL tab delimiter (not single-quoted backtick-t)", () => {
  it("formats size/path pairs with [char]9 so parseSizePathPairs can split them", async () => {
    const commands: string[] = [];
    const ctx = {
      kind: "ssh" as const,
      os: "windows" as const,
      description: "ssh user@win",
      async runShell(command: string) {
        commands.push(command);
        // Emulate the install-dir discovery returning a real tab between
        // size and path (what [char]9 produces on the wire).
        if (command.includes("[char]9")) {
          return {
            stdout: "1866410\tC:\\Program Files\\TeamViewer\\TeamViewer15_Logfile.log\n57462\tC:\\Program Files\\TeamViewer\\TVNetwork.log\n",
            stderr: "",
            exitCode: 0,
            ms: 1
          };
        }
        return { stdout: "", stderr: "", exitCode: 0, ms: 1 };
      },
      async readFile() { return "...connection lost...reconnecting..."; },
      async listDir() { return []; },
      async pathExists() { return false; }
    };
    const report = await runLogProbe(getProductProfile("teamviewer-remote"), ctx as any);
    // The discovery command must use [char]9, never the broken single-quoted
    // backtick-t form which PowerShell emits LITERALLY (no tab).
    const disc = commands.find((c) => c.includes("Get-ChildItem"));
    expect(disc).toBeDefined();
    expect(disc).toContain("[char]9");
    expect(disc).not.toContain("'{0}\\`t{1}'");
    // And the real-tab output must yield discovered files.
    expect(report.filesInspected.length).toBeGreaterThanOrEqual(2);
    expect(report.filesInspected).toContain("C:\\Program Files\\TeamViewer\\TeamViewer15_Logfile.log");
  });
});

