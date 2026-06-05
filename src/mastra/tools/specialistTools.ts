import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ActionItem, ProductKey, RootCauseCandidate } from "../../types.js";
import { getProductProfile } from "../../catalog/productProfiles.js";
import { runConnectivityProbe, type ConnectivityReport } from "../../probes/connectivity.js";
import { runEndpointHealthProbe, type EndpointHealthReport } from "../../probes/endpointHealth.js";
import { runLogProbe, type LogProbeReport } from "../../probes/logs.js";
import { runAuthPolicyProbe, type AuthProbeReport } from "../../probes/authPolicy.js";

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
    `HTTPS webapi probe: ${report.https.ok ? `HTTP ${report.https.status} in ${report.https.ms}ms` : `failed (${report.https.error})`}`
  );
  if (!report.https.ok) {
    rootCauses.push({
      title: "TeamViewer Web API unreachable over HTTPS",
      score: 0.7,
      rationale: report.https.error ?? `HTTP ${report.https.status}`
    });
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
    const okHttps = report.httpsExtra.filter((h) => h.ok).length;
    evidence.push(`${report.product ?? "Product"} HTTPS checks: ${okHttps}/${report.httpsExtra.length} OK`);
    const httpsFail = report.httpsExtra.filter(
      (h) => !h.ok && !h.bestEffort && !h.url.includes("webapi.teamviewer.com")
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
  const report = await runConnectivityProbe(resolveProfile(input.product));
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
  const report = await runEndpointHealthProbe(resolveProfile(input.product));
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
    return { evidence, rootCauses, actions };
  }
  evidence.push(`Inspected ${report.filesInspected.length} log file(s): ${report.filesInspected.join(" | ")}`);
  evidence.push(`Lines scanned: ${report.totalLines}, errors: ${report.errorCount}, warnings: ${report.warningCount}`);

  if (report.topSignatures.length > 0) {
    evidence.push(
      `Top failure signatures: ` +
        report.topSignatures.map((c) => `${c.count}\u00d7 "${c.signature.slice(0, 80)}"`).join("; ")
    );
    const dominant = report.topSignatures[0];
    if (dominant.count >= 3) {
      rootCauses.push({
        title: "Recurring failure signature in TeamViewer logs",
        score: Math.min(0.9, 0.55 + Math.log10(dominant.count) * 0.15),
        rationale: `Pattern repeats ${dominant.count}\u00d7: ${dominant.exampleLine.slice(0, 160)}`
      });
      actions.push({
        step: "Triage the dominant signature: search TeamViewer KB and correlate with last config/version change",
        risk: "low",
        rollback: "No rollback required"
      });
    }
  } else if (report.errorCount === 0) {
    evidence.push("No errors or warnings detected in log tail window.");
  }

  for (const d of report.diagnostics) evidence.push(d);
  return { evidence, rootCauses, actions };
}

export async function runLogIntelligenceAnalysis(
  input: z.infer<typeof specialistInputSchema>
): Promise<SpecialistOutput> {
  const report = runLogProbe(resolveProfile(input.product));
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
