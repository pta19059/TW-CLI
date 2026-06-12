import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ActionItem, ProductKey, RootCauseCandidate } from "../../types.js";
import { getProductProfile } from "../../catalog/productProfiles.js";
import { runConnectivityProbe, type ConnectivityReport } from "../../probes/connectivity.js";
import { runEndpointHealthProbe, type EndpointHealthReport } from "../../probes/endpointHealth.js";
import { runLogProbe, classifySignature, type LogProbeReport, type SignatureCategory } from "../../probes/logs.js";
import { runAuthPolicyProbe, type AuthProbeReport } from "../../probes/authPolicy.js";
import { getCurrentContext, getRunOptions } from "../../runtime/runContext.js";

function resolveProfile(product?: string) {
  return getProductProfile((product as ProductKey) ?? "teamviewer-remote");
}

const specialistInputSchema = z.object({
  product: z.string().optional(),
  target: z.string(),
  issue: z.string(),
  context: z.string().optional()
});

const specialistOutputSchema = z.object({
  evidence: z.array(z.string()),
  rootCauses: z.array(
    z.object({
      title: z.string(),
      score: z.number(),
      rationale: z.string()
    })
  ),
  actions: z.array(
    z.object({
      step: z.string(),
      risk: z
        .string()
        .transform((s) => s.trim().toLowerCase())
        .pipe(z.enum(["low", "medium", "high"])),
      rollback: z.string()
    })
  )
});

export interface SpecialistOutput {
  evidence: string[];
  rootCauses: RootCauseCandidate[];
  actions: ActionItem[];
  /** Concrete log sources the probe actually read (file paths, the macOS
   *  unified-log command, the kubectl/journalctl invocation, etc). Surfaced in
   *  the rendered report so the user can see EXACTLY which logs were consulted
   *  on the target — applies to macOS, Windows, Kubernetes and cloud VMs. Only
   *  the log specialist populates this. */
  logSources?: LogSource[];
}

export interface LogSource {
  /** Path or command of the consulted source. */
  source: string;
  /** Optional one-line detail (line/error/warning counts, byte size, window). */
  detail?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Connectivity — real DNS / TCP / HTTPS probes
// ──────────────────────────────────────────────────────────────────────────

export function fromConnectivity(report: ConnectivityReport, target: string): SpecialistOutput {
  const evidence: string[] = [];
  const rootCauses: RootCauseCandidate[] = [];
  const actions: ActionItem[] = [];

  const dnsFail = report.dns.filter((d) => !d.ok);
  const dnsOk = report.dns.filter((d) => d.ok);
  evidence.push(`DNS resolved ${dnsOk.length}/${report.dns.length} TeamViewer hosts from ${target}`);
  if (dnsFail.length > 0) {
    evidence.push(`DNS failures: ${dnsFail.map((d) => `${d.host} (${d.error})`).join("; ")}`);
    rootCauses.push({
      title: "DNS resolution failure for TeamViewer endpoints",
      score: 0.88,
      rationale: `Could not resolve: ${dnsFail.map((d) => d.host).join(", ")}`
    });
    actions.push({
      step: "Check DNS server, nslookup router1.teamviewer.com, verify hosts file is clean",
      risk: "low",
      rollback: "No rollback required"
    });
  }

  const tcpFail = report.tcp5938.filter((t) => !t.ok);
  if (report.tcp5938.length > 0) {
    evidence.push(
      `TCP 5938 reachability: ${report.tcp5938.length - tcpFail.length}/${report.tcp5938.length} routers OK`
    );
  }
  if (tcpFail.length > 0) {
    evidence.push(`TCP 5938 blocked for: ${tcpFail.map((t) => `${t.host} (${t.error})`).join("; ")}`);
    rootCauses.push({
      title: "TeamViewer primary port 5938 blocked or filtered",
      score: 0.86,
      rationale: `Cannot open TCP socket to ${tcpFail.map((t) => t.host).join(", ")} on port 5938`
    });
    actions.push({
      step: "Open egress TCP 5938 in firewall/NSG, or allow fallback to 443 in TeamViewer client settings",
      risk: "medium",
      rollback: "Restore previous firewall/NSG rule set"
    });
  }

  evidence.push(
    `HTTPS webapi probe: ${
      report.https.ok
        ? `HTTP ${report.https.status} in ${report.https.ms}ms`
        : report.https.tlsValidationFailed
          ? `reachable but TLS validation failed locally (${report.https.error})`
          : `failed (${report.https.error})`
    }`
  );
  if (!report.https.ok) {
    if (report.https.tlsValidationFailed) {
      // TLS validation failure is a PROBE-LOCAL hygiene issue (stale CA bundle
      // on the host running curl, NOT a TeamViewer connectivity problem).
      // The server WAS reachable. Do NOT add a root cause — it would mislead
      // the synthesiser into blaming TLS for whatever symptom the user reported.
      // Surface as an explicit caveat in evidence and offer a low-risk hygiene
      // action so a future run gets a clean HTTPS probe.
      evidence.push(
        "Note: the HTTPS failure above is a LOCAL certificate-validation issue on the probe host (likely outdated CA bundle, e.g. macOS Monterey). The TeamViewer Web API itself answered HTTP 200 when validation was bypassed — it is NOT a candidate root cause for the user's symptom."
      );
      actions.push({
        step:
          "(Probe hygiene, not a fix) Refresh the host CA bundle / system trust store: macOS — install latest macOS updates; Linux — refresh ca-certificates; verify system clock. Do NOT change the host firewall — connectivity is fine.",
        risk: "low",
        rollback: "Revert to the previous ca-certificates package if the new bundle breaks an internal CA"
      });
    } else {
      rootCauses.push({
        title: "TeamViewer Web API unreachable over HTTPS",
        score: 0.7,
        rationale: report.https.error ?? `HTTP ${report.https.status}`
      });
    }
  }

  // ── Product-specific endpoint reachability (e.g. 443 to SaaS consoles) ──
  if (report.tcpExtra && report.tcpExtra.length > 0) {
    const extraFail = report.tcpExtra.filter((t) => !t.ok);
    const okCount = report.tcpExtra.length - extraFail.length;
    evidence.push(`${report.product ?? "Product"} endpoint TCP reachability: ${okCount}/${report.tcpExtra.length} OK`);
    const hardFail = extraFail.filter((t) => !t.bestEffort);
    const softFail = extraFail.filter((t) => t.bestEffort);
    if (hardFail.length > 0) {
      evidence.push(`Blocked product endpoints: ${hardFail.map((t) => `${t.host}:${t.port} (${t.error})`).join("; ")}`);
      rootCauses.push({
        title: `${report.product ?? "Product"} endpoint unreachable`,
        score: 0.8,
        rationale: `Cannot reach ${hardFail.map((t) => `${t.host}:${t.port}`).join(", ")}`
      });
      actions.push({
        step: `Allow egress to the product endpoints (${hardFail.map((t) => `${t.host}:${t.port}`).join(", ")}) in firewall/proxy`,
        risk: "medium",
        rollback: "Restore previous firewall/proxy rules"
      });
    }
    if (softFail.length > 0) {
      evidence.push(
        `Note: tenant/region-dependent endpoints unreachable (verify exact hostnames for your tenant): ${softFail.map((t) => `${t.host}:${t.port}`).join("; ")}`
      );
    }
  }
  if (report.httpsExtra && report.httpsExtra.length > 0) {
    // Distinguish "reachable but local TLS validation failed" from real
    // network failures. The former is a probe-host hygiene issue (stale CA
    // bundle, e.g. macOS Monterey) and must NOT add a root cause — the
    // headline webapi probe already covers the hygiene action.
    const okHttps = report.httpsExtra.filter((h) => h.ok).length;
    const tlsOnlyCount = report.httpsExtra.filter((h) => !h.ok && h.tlsValidationFailed).length;
    const summaryParts = [`${okHttps}/${report.httpsExtra.length} OK`];
    if (tlsOnlyCount > 0) summaryParts.push(`${tlsOnlyCount} reachable but local TLS validation failed`);
    evidence.push(`${report.product ?? "Product"} HTTPS checks: ${summaryParts.join(", ")}`);
    const httpsFail = report.httpsExtra.filter(
      (h) =>
        !h.ok &&
        !h.tlsValidationFailed &&
        !h.bestEffort &&
        !h.url.includes("webapi.teamviewer.com")
    );
    for (const h of httpsFail) {
      rootCauses.push({
        title: `Product HTTPS endpoint unreachable: ${h.url}`,
        score: 0.66,
        rationale: h.error ?? `HTTP ${h.status}`
      });
    }
  }

  if (rootCauses.length === 0) {
    evidence.push("All baseline connectivity probes succeeded.");
  }
  return { evidence, rootCauses, actions };
}

export async function runConnectivityAnalysis(
  input: z.infer<typeof specialistInputSchema>
): Promise<SpecialistOutput> {
  const report = await runConnectivityProbe(resolveProfile(input.product), getCurrentContext());
  return fromConnectivity(report, input.target);
}

// ──────────────────────────────────────────────────────────────────────────
// Endpoint health — Get-Service, registry, processes
// ──────────────────────────────────────────────────────────────────────────

export function fromEndpointHealth(report: EndpointHealthReport, target: string): SpecialistOutput {
  const evidence: string[] = [];
  const rootCauses: RootCauseCandidate[] = [];
  const actions: ActionItem[] = [];

  evidence.push(
    `Host ${report.hostname} (${report.platform} ${report.osRelease}), uptime ${(report.uptimeSec / 3600).toFixed(1)}h, free RAM ${report.freeMemMb}/${report.totalMemMb} MB`
  );

  // Platform-specific remediation snippets so the guidance is actionable on the
  // actual host OS (TeamViewer runs on Windows, Linux and macOS).
  const startCmd = (svc: string): string => {
    switch (report.platform) {
      case "win32":
        return `Start-Service ${svc} ; Set-Service -Name ${svc} -StartupType Automatic`;
      case "linux":
        return `sudo systemctl enable --now ${svc}`;
      case "darwin":
        return `sudo launchctl load -w /Library/LaunchDaemons/com.teamviewer.teamviewerd.plist`;
      default:
        return `Start the ${svc} service using your platform's service manager`;
    }
  };
  const stopCmd = (svc: string): string =>
    report.platform === "win32"
      ? `Stop-Service ${svc}`
      : report.platform === "linux"
        ? `sudo systemctl stop ${svc}`
        : `sudo launchctl unload /Library/LaunchDaemons/com.teamviewer.teamviewerd.plist`;
  const installHint =
    report.platform === "win32"
      ? "HKLM\\SOFTWARE\\TeamViewer registry probe returned nothing"
      : report.platform === "linux"
        ? "`teamviewer --info` returned no version/ID and no teamviewerd unit was found"
        : report.platform === "darwin"
          ? "TeamViewer.app not found under /Applications and no launchctl entry"
          : "no install signal on this platform";

  if (report.installedVersion || report.clientId) {
    evidence.push(
      `TeamViewer installed${report.installedVersion ? `: version ${report.installedVersion}` : ""}` +
        (report.clientId ? `${report.installedVersion ? "," : ":"} ClientID ${report.clientId}` : "")
    );
  } else if (report.services.length === 0 && report.processes.length === 0) {
    if (report.deliveryModel === "cloud-or-mobile") {
      // Cloud/mobile-first product: no host agent is expected here.
      evidence.push(
        `${report.product ?? "This product"} has no host agent on ${report.platform} (expected for a cloud/mobile product); diagnose via connectivity + Web API instead.`
      );
    } else {
      // No version, no service, no process anywhere → strong "not installed" signal.
      evidence.push(`TeamViewer install not detected on ${report.platform}.`);
      rootCauses.push({
        title: "TeamViewer not installed / not detectable on target",
        score: report.platform === "win32" ? 0.9 : 0.75,
        rationale: installHint
      });
      actions.push({
        step:
          report.platform === "linux"
            ? "Install the TeamViewer Host/Full package and ensure the `teamviewer` CLI is on PATH, then re-run"
            : report.platform === "darwin"
              ? "Install TeamViewer to /Applications (or verify the install path), then re-run"
              : "Install TeamViewer or verify install path; re-run after install",
        risk: "low",
        rollback: "Uninstall via the platform's standard package/app manager"
      });
    }
  }

  const svcName = report.services[0]?.name ?? (report.platform === "linux" ? "teamviewerd" : "TeamViewer");
  if (report.services.length > 0) {
    evidence.push(`Services: ${report.services.map((s) => `${s.name}=${s.status ?? "?"}`).join(", ")}`);
    const stopped = report.services.filter((s) => s.status && s.status !== "Running");
    if (stopped.length > 0) {
      rootCauses.push({
        title: "TeamViewer service not running",
        score: 0.85,
        rationale: `Stopped: ${stopped.map((s) => `${s.name}=${s.status}`).join(", ")}`
      });
      actions.push({
        step: `Start the service: ${startCmd(stopped.map((s) => s.name).join(report.platform === "win32" ? "," : " "))}`,
        risk: "low",
        rollback: `${stopCmd(svcName)} if regression`,
        command: startCmd(stopped.map((s) => s.name).join(report.platform === "win32" ? "," : " "))
      });
    }
  } else if (report.installedVersion || report.clientId) {
    // Installed but no service object found — flag it on every platform.
    rootCauses.push({
      title: "TeamViewer background service not registered",
      score: 0.7,
      rationale:
        report.platform === "win32"
          ? "Get-Service for TeamViewer / TeamViewer_Service returned empty"
          : report.platform === "linux"
            ? "systemctl could not find the teamviewerd unit"
            : "launchctl listed no TeamViewer daemon"
    });
    actions.push({
      step: `Register/start the background service: ${startCmd(svcName)}`,
      risk: "low",
      rollback: `${stopCmd(svcName)} if regression`,
      command: startCmd(svcName)
    });
  }

  if (report.processes.length === 0 && (report.installedVersion || report.clientId)) {
    rootCauses.push({
      title: "TeamViewer process not running",
      score: 0.65,
      rationale:
        report.platform === "win32"
          ? "Get-Process TeamViewer* returned empty while install is present"
          : "pgrep found no teamviewer process while an install is present"
    });
    actions.push({
      step:
        report.platform === "win32"
          ? "Launch TeamViewer.exe or restart the TeamViewer service"
          : `Start the daemon (${startCmd(svcName)}) or launch the TeamViewer client`,
      risk: "low",
      rollback: "Stop the process via the platform's process manager",
      command: report.platform === "win32" ? undefined : startCmd(svcName)
    });
  } else if (report.processes.length > 0) {
    evidence.push(`Processes running: ${report.processes.join(", ")}`);
  }

  for (const note of report.diagnostics) evidence.push(note);

  if (rootCauses.length === 0) evidence.push(`Endpoint health probes for ${target} returned no anomalies.`);
  return { evidence, rootCauses, actions };
}

export async function runEndpointHealthAnalysis(
  input: z.infer<typeof specialistInputSchema>
): Promise<SpecialistOutput> {
  const report = await runEndpointHealthProbe(resolveProfile(input.product), getCurrentContext());
  return fromEndpointHealth(report, input.target);
}

// ──────────────────────────────────────────────────────────────────────────
// Logs — TeamViewer logfile scan + signature clustering
// ──────────────────────────────────────────────────────────────────────────

export function fromLogs(report: LogProbeReport): SpecialistOutput {
  const evidence: string[] = [];
  const rootCauses: RootCauseCandidate[] = [];
  const actions: ActionItem[] = [];

  if (report.filesInspected.length === 0) {
    evidence.push("No TeamViewer log files found on this host.");
    // Surface why — the probe pushed candidate-path diagnostics into
    // report.diagnostics (missing | unreadable | exists/empty). Don't drop
    // them: this is the ONLY signal the user has to debug TCC / Full Disk
    // Access / path-mismatch issues on macOS hosts reached via SSH.
    for (const d of report.diagnostics) evidence.push(d);
    return { evidence, rootCauses, actions, logSources: [] };
  }
  evidence.push(`Inspected ${report.filesInspected.length} log file(s): ${report.filesInspected.join(" | ")}`);
  evidence.push(`Lines scanned: ${report.totalLines}, errors: ${report.errorCount}, warnings: ${report.warningCount}`);

  // Power-management correlation (macOS). When the real disconnects are macOS
  // entering standby, the post-wake RetryHandle/RCommand burst is just
  // reconnection noise — so we DEMOTE that signature below and surface standby
  // as the actual evidence-anchored root cause further down.
  const power = report.power;
  const standbyExplainsDrops = !!power && power.standbyDisconnects > 0;
  const osName = power?.os === "windows" ? "Windows" : power?.os === "linux" ? "Linux" : "macOS";

  if (report.topSignatures.length > 0) {
    evidence.push(
      `Top failure signatures: ` +
        report.topSignatures.map((c) => `${c.count}\u00d7 "${c.signature.slice(0, 200)}"`).join("; ")
    );
    const dominant = report.topSignatures[0];
    // Use the probe-computed classification when present, else recompute — so
    // fromLogs is correct even for externally-built reports / tests.
    const cls = classifySignature(`${dominant.exampleLine} ${dominant.signature}`);
    const domCategory: SignatureCategory = dominant.category ?? cls.category;
    const domWeight = dominant.weight ?? cls.weight;

    if (domCategory === "benign") {
      // The most-recurring lines are cosmetic (device enumeration, management
      // polling, driver buffer probes). They are NOT a credible cause of a
      // disconnect — say so honestly instead of fabricating a "driver" cause.
      // No fault root cause is emitted; the LLM enrichment + other probes
      // decide whether anything real remains.
      evidence.push(
        "The most frequent recurring log lines are cosmetic/benign (device enumeration, " +
          "management polling, driver buffer probes) and do NOT indicate a connectivity " +
          "fault \u2014 no genuine fault signature was found in the scanned window."
      );
    } else if (dominant.count >= 3) {
      const sigText = `${dominant.exampleLine} ${dominant.signature}`.toLowerCase();
      // When standby is the PROVEN cause of the drops, the WHOLE recurring
      // error burst at wake is reconnection aftermath, not just the retry
      // lines: the client re-establishes its master link and its license
      // check (TAF::CMML / GetLicenseLimit), chat-provider registration and
      // resend/retry subsystems all fail transiently until the session is
      // back. This is gated on standbyExplainsDrops, so a genuine license or
      // timeout problem on a machine that ISN'T sleeping is never demoted.
      const isReconnectNoise =
        standbyExplainsDrops &&
        /retryhandle|::handleretry|resend to|rcommand|retry|netwatchdog|reconnect|taf::|cmml|licenselimit|getlicense|licensecallback|chatprovider|providerregistration|registration failed|timed? ?out|timeout/.test(sigText);
      rootCauses.push({
        title: "Recurring failure signature in TeamViewer logs",
        // Score factors BOTH frequency and diagnostic severity (domWeight):
        // a high-severity fault category scores above a generic recurring line
        // of equal count, and the score can't be inflated by sheer volume of a
        // low-severity pattern.
        score: isReconnectNoise
          ? 0.35
          : Math.min(0.9, 0.5 + Math.log10(dominant.count) * 0.15 + (domWeight - 1) * 0.05),
        rationale:
          `Pattern repeats ${dominant.count}\u00d7: ${dominant.exampleLine.slice(0, 260)}` +
          (isReconnectNoise
            ? " \u2014 note: these coincide with the " + osName + " standby wake events; they are reconnection aftermath, not the root cause (see the power-management finding)."
            : "")
      });
      // Signature-aware action routing driven by the CLASSIFIED category (not
      // an ad-hoc regex), so each failure mode (DNS, TLS, transport/network,
      // auth) gets its specific remediation playbook. Falls back to a generic
      // triage step for unclassified ("generic"/"crash") signatures.
      if (domCategory === "dns") {

        actions.push({
          step:
            "DNS resolution failures detected for TeamViewer router hostnames " +
            "(curl 'Could not resolve hostname'). Check the DNS resolver chain " +
            "on this host: macOS — `scutil --dns` (look for slow/dead resolvers, " +
            "VPN/MDM-pushed overrides), `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`. " +
            "Linux — `resolvectl status`, `systemd-resolve --flush-caches`. " +
            "Verify direct resolution against a public resolver: `dig router11.teamviewer.com @1.1.1.1`. " +
            "If the public resolver works but the configured one doesn't, the issue is the local resolver, not TeamViewer.",
          risk: "low",
          rollback: "Flushing the DNS cache is reversible (entries repopulate on use). Removing custom resolvers can be reverted by re-adding them."
        });
      } else if (domCategory === "tls") {
        actions.push({
          step:
            "TLS / handshake failures dominate the log signature. Verify the system clock " +
            "(`date` — TLS rejects future/past clocks), refresh the CA bundle (macOS: install " +
            "OS updates so the root store is current; Linux: refresh ca-certificates), and " +
            "check for TLS-intercepting proxies/firewalls (corporate inspection, captive portals, " +
            "MDM CA injection) in the path to *.teamviewer.com:443.",
          risk: "low",
          rollback: "Reverting ca-certificates / removing the TLS-inspection bypass restores prior behavior."
        });
      } else if (domCategory === "transport" || domCategory === "network") {
        if (standbyExplainsDrops) {
          actions.push({
            step:
              "These RetryHandle / RCommand retry bursts line up with the " + osName + " standby/sleep " +
              "events detected below \u2014 they are reconnection noise after the machine slept, NOT a " +
              "live-session network fault. Fix the standby drops first (see the power-management " +
              "root cause). ONLY if drops ALSO happen during an ACTIVE remote-control session " +
              "(machine awake) should you measure link quality: `ping -c 50 router11.teamviewer.com` " +
              "(loss & jitter), MTR/`traceroute -T -p 5938`, and check upstream NAT/firewall idle-timeout.",
            risk: "low",
            rollback: "Observation steps only — no rollback needed."
          });
        } else {
          actions.push({
            step:
              "Transport-layer instability dominates the log (timeouts / disconnects / TeamViewer " +
              "internal RetryHandle / RCommand retries — TeamViewer is repeatedly resending " +
              "commands because replies don't arrive in time). This is a network-path symptom, " +
              "not a TeamViewer bug. Measure link quality to the routers: " +
              "`ping -c 50 router11.teamviewer.com` (loss & jitter), MTR/`traceroute -T -p 5938`. " +
              "If intermittent, capture a 2-min `tcpdump`/`pktmon` on port 5938. Check upstream " +
              "NAT/firewall for idle-timeout < 60s and any rate-limiting on long-lived TCP sessions; " +
              "if on Wi-Fi, test on Ethernet to isolate radio packet loss.",
            risk: "low",
            rollback: "Observation steps only — no rollback needed."
          });
        }
      } else if (domCategory === "auth") {

        actions.push({
          step:
            "Authentication-class failures dominate. Re-verify the account token / device " +
            "assignment status, check token scope and expiry, and confirm the device is still " +
            "enrolled in the expected account.",
          risk: "low",
          rollback: "No rollback required for read-only checks."
        });
      } else {
        actions.push({
          step: "Triage the dominant signature: search TeamViewer KB and correlate with last config/version change",
          risk: "low",
          rollback: "No rollback required"
        });
      }
    }
  } else if (report.errorCount === 0) {
    evidence.push("No errors or warnings detected in log tail window.");
  }

  // Standby / power-management root cause. This is the high-value correction:
  // an idle machine that enters standby drops the TeamViewer connection and
  // reconnects on wake, producing the RetryHandle burst that the signature
  // clustering otherwise misattributes. Surface it as an evidence-anchored
  // root cause (baseline → tagged evidenceAnchored=true in the workflow merge).
  // OS-aware: macOS uses pmset + NetWatchdog; Windows uses powercfg +
  // Kernel-Power sleep/resume events. (Cloud VMs / Kubernetes pods never sleep,
  // so `power` is undefined there and this whole block is skipped.)
  if (power) {
    const isWindows = power.os === "windows";
    const isLinux = power.os === "linux";
    const configSummary = isWindows || isLinux ? power.powercfgSummary : power.pmsetSummary;
    if (configSummary) {
      evidence.push(
        isWindows
          ? `Windows power management (powercfg): ${configSummary}.`
          : isLinux
            ? `Linux power management (systemd): ${configSummary}.`
            : `macOS power management (pmset): ${configSummary}.`
      );
    }
    if (power.standbyDisconnects > 0) {
      const when = power.disconnectTimes.length
        ? ` (e.g. ${power.disconnectTimes.slice(-3).join(", ")})`
        : "";
      if (isWindows) {
        evidence.push(
          `Kernel-Power logged ${power.standbyDisconnects} sleep-enter event(s) (Event ID 42/506) ` +
            `and ${power.wakeRecoveries} resume event(s) (Event ID 107/507) in the last 24h${when}. ` +
            `Each idle-sleep drops the TeamViewer connection until the machine wakes.`
        );
      } else if (isLinux) {
        evidence.push(
          `systemd-logind logged ${power.standbyDisconnects} suspend transition(s) and ` +
            `${power.wakeRecoveries} resume(s) in the last 24h${when}. ` +
            `Each suspend drops the TeamViewer connection until the machine wakes.`
        );
      } else {
        evidence.push(
          `NetWatchdog logged ${power.standbyDisconnects} standby disconnect event(s) ` +
            `("Completely disconnected. Going offline") and ${power.wakeRecoveries} wake recovery(ies) ` +
            `in the last 24h${when}.`
        );
      }
      const cfg = isWindows
        ? [
            power.standbyEnabled === true ? "idle-sleep enabled" : power.standbyEnabled === false ? "idle-sleep disabled" : null,
            typeof power.standbyDelayLowSec === "number" ? `standby-timeout(AC)=${power.standbyDelayLowSec}s` : null
          ]
            .filter(Boolean)
            .join(", ")
        : isLinux
          ? [
              power.standbyEnabled === true ? "suspend available" : power.standbyEnabled === false ? "suspend masked" : null
            ]
              .filter(Boolean)
              .join(", ")
          : [
              power.standbyEnabled === true ? "standby=on" : power.standbyEnabled === false ? "standby=off" : null,
              power.powerNapEnabled === false ? "powernap=off" : power.powerNapEnabled === true ? "powernap=on" : null,
              power.tcpKeepAlive === false ? "tcpkeepalive=off" : null,
              typeof power.standbyDelayLowSec === "number" ? `standbydelaylow=${power.standbyDelayLowSec}s` : null
            ]
              .filter(Boolean)
              .join(", ");
      rootCauses.push({
        title: `${osName} standby/sleep is dropping the idle TeamViewer connection`,
        score: Math.min(0.92, 0.7 + Math.log10(power.standbyDisconnects + 1) * 0.2),
        rationale: isWindows
          ? `The Windows Kernel-Power log reported ${power.standbyDisconnects} sleep-enter event(s) ` +
            `(Event ID 42/506), each followed by a resume on wake \u2014 this is the actual disconnect ` +
            `pattern. ${cfg ? `Power settings: ${cfg}. ` : ""}` +
            `When the machine goes idle it sleeps and the connection drops until wake; the RetryHandle/RCommand ` +
            `errors are the reconnection aftermath, not the cause.`
          : isLinux
            ? `systemd-logind reported ${power.standbyDisconnects} suspend transition(s), each followed by a ` +
              `resume on wake \u2014 this is the actual disconnect pattern. ${cfg ? `Power settings: ${cfg}. ` : ""}` +
              `When the machine goes idle it suspends and the connection drops until wake; the RetryHandle/RCommand ` +
              `errors are the reconnection aftermath, not the cause.`
            : `The macOS NetWatchdog reported ${power.standbyDisconnects} "Completely disconnected. Going offline" ` +
              `event(s) as the Mac entered standby, each followed by a reconnect on wake \u2014 this is the actual ` +
              `disconnect pattern. ${cfg ? `Power settings: ${cfg}. ` : ""}` +
              `When the machine goes idle it sleeps and the connection drops until wake; the RetryHandle/RCommand ` +
              `errors are the reconnection aftermath, not the cause.`
      });
      if (isWindows) {
        actions.push({
          step:
            "Stop Windows from sleeping while TeamViewer must stay reachable. For unattended access, " +
            "enable TeamViewer \u2192 Extras \u2192 Options \u2192 Advanced \u2192 'Prevent System from sleeping', " +
            "or keep it awake at the OS level (Admin PowerShell): `powercfg /change standby-timeout-ac 0` " +
            "and `powercfg /change standby-timeout-dc 0`. Verify with `powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`. " +
            "If the machine MUST sleep, drops while asleep are by design \u2014 not a TeamViewer fault.",
          risk: "low",
          rollback: "Re-apply the previous idle-sleep timeout with `powercfg /change standby-timeout-ac <old-seconds>` (capture it first with `powercfg /q`)."
        });
      } else if (isLinux) {
        actions.push({
          step:
            "Stop Linux from suspending while TeamViewer must stay reachable. On a server/headless host " +
            "mask the sleep targets: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`. " +
            "On a desktop, disable automatic suspend in the power settings (GNOME: Settings \u2192 Power \u2192 " +
            "'Automatic Suspend' Off). Verify with `systemctl status sleep.target` and `journalctl -u systemd-logind`. " +
            "If the machine MUST suspend, drops while suspended are by design \u2014 not a TeamViewer fault.",
          risk: "low",
          rollback: "Re-enable suspend with `sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target` (or re-enable Automatic Suspend in the desktop power settings)."
        });
      } else {
        actions.push({
          step:
            "Stop the Mac from sleeping while TeamViewer must stay reachable. For unattended access, " +
            "enable TeamViewer \u2192 Preferences \u2192 Advanced \u2192 'Prevent System from sleeping' (Unattended " +
            "Access), or keep it awake at the OS level: `sudo pmset -a sleep 0 standby 0 powernap 1 " +
            "tcpkeepalive 1` (on AC power), or run `caffeinate -s` during sessions. Verify with `pmset -g`. " +
            "If the Mac MUST sleep, drops while asleep are by design \u2014 not a TeamViewer fault.",
          risk: "low",
          rollback: "Capture `pmset -g` before changing, then restore prior values with `sudo pmset -a sleep <old> standby <old> powernap <old>`."
        });
      }
    } else if (configSummary) {
      evidence.push(
        `No ${osName} standby-related TeamViewer disconnects in the last 24h \u2014 idle-sleep is ruled out as the cause.`
      );
    }
  }

  for (const d of report.diagnostics) evidence.push(d);

  // Structured list of the log sources actually consulted, so the report can
  // show the user EXACTLY which logs were read on the target (macOS unified
  // log, Windows TVNetwork.log, a Linux file, kubectl/journalctl output...).
  const logSources: LogSource[] = report.filesInspected.map((f): LogSource => {
    if (/^<\s*macos unified log/i.test(f)) {
      return {
        source: "macOS unified log (Apple os_log)",
        detail:
          `log show --predicate 'process CONTAINS "TeamViewer"' --info --last 24h` +
          ` \u00b7 ${report.totalLines} lines, ${report.errorCount} err, ${report.warningCount} warn`
      };
    }
    return { source: f };
  });
  // When real files were read, attach the aggregate scan totals to the first
  // entry so the counts are visible without re-reading the Evidence block.
  if (logSources.length > 0 && !logSources[0].detail) {
    logSources[0].detail = `${report.totalLines} lines scanned, ${report.errorCount} err, ${report.warningCount} warn (across ${logSources.length} file(s))`;
  }

  return { evidence, rootCauses, actions, logSources };
}

export async function runLogIntelligenceAnalysis(
  input: z.infer<typeof specialistInputSchema>
): Promise<SpecialistOutput> {
  const report = await runLogProbe(
    resolveProfile(input.product),
    getCurrentContext(),
    getRunOptions().captureWindowSec
  );
  return fromLogs(report);
}

// ──────────────────────────────────────────────────────────────────────────
// Auth / Policy — TeamViewer Web API (requires TEAMVIEWER_API_TOKEN)
// ──────────────────────────────────────────────────────────────────────────

export function fromAuth(report: AuthProbeReport, target?: string): SpecialistOutput {
  const evidence: string[] = [];
  const rootCauses: RootCauseCandidate[] = [];
  const actions: ActionItem[] = [];

  if (!report.tokenPresent) {
    evidence.push("TEAMVIEWER_API_TOKEN not set; auth/policy probes skipped.");
    actions.push({
      step: "Generate a script/personal token in Management Console and export TEAMVIEWER_API_TOKEN",
      risk: "low",
      rollback: "Revoke the token in Management Console"
    });
    return { evidence, rootCauses, actions };
  }

  evidence.push(`WebAPI /ping: ${report.pingOk ? `HTTP ${report.pingStatus}` : `FAIL (${report.pingStatus})`}`);
  if (!report.pingOk) {
    rootCauses.push({
      title: "TeamViewer Web API unreachable from this host",
      score: 0.8,
      rationale: `HTTPS to webapi.teamviewer.com returned ${report.pingStatus}`
    });
  }

  evidence.push(`WebAPI /account: ${report.accountOk ? `HTTP ${report.accountStatus}` : `FAIL (${report.accountStatus})`}`);
  if (!report.accountOk) {
    rootCauses.push({
      title: "TeamViewer API token rejected or insufficient scopes",
      score: 0.88,
      rationale: `GET /account returned HTTP ${report.accountStatus}`
    });
    actions.push({
      step: "Regenerate the script token with required scopes (Account, User management, Devices)",
      risk: "low",
      rollback: "Revert to the previous token"
    });
  } else {
    evidence.push(
      `Authenticated as ${report.accountName ?? report.accountEmail ?? "?"}` +
        (report.companyName ? ` @ ${report.companyName}` : "")
    );
    if (typeof report.devicesCount === "number") {
      evidence.push(`Devices visible to this token: ${report.devicesCount}`);
    }
    if (report.devices && report.devices.length > 0) {
      const shown = report.devices
        .slice(0, 10)
        .map((d) => `${d.name} (${d.online ? "online" : "offline"})`)
        .join(", ");
      evidence.push(`Managed devices: ${shown}${report.devices.length > 10 ? ", …" : ""}`);

      // If the caller named a target (e.g. the demo VM), report its state and
      // flag it when the remote endpoint is enrolled but currently offline.
      const needle = target?.trim().toLowerCase();
      if (needle) {
        const match = report.devices.find((d) => d.name.toLowerCase().includes(needle));
        if (match) {
          evidence.push(`Target '${target}' matches managed device '${match.name}' — ${match.online ? "online" : "offline"}.`);
          if (!match.online) {
            rootCauses.push({
              title: "Target device enrolled but offline",
              score: 0.72,
              rationale: `'${match.name}' is registered in the account but reports online_state=offline`
            });
            actions.push({
              step: `Verify the TeamViewer service is running on '${match.name}' and that it can reach TCP 5938 / 443 outbound`,
              risk: "low",
              rollback: "No rollback required"
            });
          }
        } else {
          evidence.push(`Target '${target}' not found among managed devices — not enrolled in this account yet.`);
        }
      }
    }
  }

  // Product-specific Web API surface (e.g. Tensor policy/SSO: /users, /managedgroups).
  if (report.policyChecks && report.policyChecks.length > 0) {
    const okChecks = report.policyChecks.filter((c) => c.ok).length;
    evidence.push(
      `${report.product ?? "Product"} policy/API surface: ${okChecks}/${report.policyChecks.length} endpoint(s) accessible`
    );
    for (const c of report.policyChecks.filter((c) => !c.ok)) {
      rootCauses.push({
        title: `Web API ${c.path} not accessible`,
        score: 0.6,
        rationale: `${c.path} returned HTTP ${c.status} — token scope or policy access likely missing`
      });
    }
  }

  for (const d of report.diagnostics) evidence.push(d);
  return { evidence, rootCauses, actions };
}

export async function runAuthPolicyAnalysis(
  input: z.infer<typeof specialistInputSchema>
): Promise<SpecialistOutput> {
  const report = await runAuthPolicyProbe(resolveProfile(input.product));
  return fromAuth(report, input.target);
}

// ──────────────────────────────────────────────────────────────────────────
// Mastra createTool wrappers
// ──────────────────────────────────────────────────────────────────────────

export const connectivityTool = createTool({
  id: "tw-connectivity-analysis",
  description: "Run real DNS + TCP 5938 + HTTPS probes against TeamViewer endpoints",
  inputSchema: specialistInputSchema,
  outputSchema: specialistOutputSchema,
  execute: async (input: z.infer<typeof specialistInputSchema>) => runConnectivityAnalysis(input)
});

export const authPolicyTool = createTool({
  id: "tw-auth-policy-analysis",
  description: "Validate TeamViewer Web API token and account/policy reachability",
  inputSchema: specialistInputSchema,
  outputSchema: specialistOutputSchema,
  execute: async (input: z.infer<typeof specialistInputSchema>) => runAuthPolicyAnalysis(input)
});

export const endpointHealthTool = createTool({
  id: "tw-endpoint-health-analysis",
  description: "Inspect TeamViewer Windows services, processes, registry version and host resources",
  inputSchema: specialistInputSchema,
  outputSchema: specialistOutputSchema,
  execute: async (input: z.infer<typeof specialistInputSchema>) => runEndpointHealthAnalysis(input)
});

export const logIntelligenceTool = createTool({
  id: "tw-log-intelligence-analysis",
  description: "Scan TeamViewer logfiles and cluster repeating error/warning signatures",
  inputSchema: specialistInputSchema,
  outputSchema: specialistOutputSchema,
  execute: async (input: z.infer<typeof specialistInputSchema>) => runLogIntelligenceAnalysis(input)
});
