// Real endpoint-health probes with first-class coverage for Windows, Linux and
// macOS. The set of services/processes to inspect is driven by the per-product
// profile, so Remote/Tensor look for the core client, Remote Management looks
// for the monitoring agent, DEX looks for the 1E Client, etc. Cloud-/mobile-only
// products report "no local agent" as context rather than a fault.
//
// Execution model: every host-touching call goes through an ExecutionContext,
// so the same probe works locally (LocalContext) or against a remote host over
// SSH (SshContext). The branch picked (windows/linux/macos commands) is driven
// by ctx.os — the *target* OS — not by process.platform.

import os from "node:os";
import { getProductProfile, type DeliveryModel, type ProductDiagnosticProfile } from "../catalog/productProfiles.js";
import { LocalContext, type ExecutionContext, type RemoteOs } from "../runtime/execContext.js";

function psList(names: string[]): string {
  return names.map((n) => `'${n.replace(/'/g, "''")}'`).join(",");
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ServiceInfo {
  name: string;
  status?: string;
  startType?: string;
}

export interface EndpointHealthReport {
  /** Kept as NodeJS.Platform for backward compatibility with the existing
   *  specialistTools / report renderers. Mapped from ctx.os, NOT from
   *  process.platform, so a remote SSH probe to a Mac always reports "darwin"
   *  even when the CLI runs on Windows. */
  platform: NodeJS.Platform;
  osRelease: string;
  hostname: string;
  freeMemMb: number;
  totalMemMb: number;
  uptimeSec: number;
  services: ServiceInfo[];
  processes: string[];
  installedVersion?: string;
  clientId?: string;
  diagnostics: string[];
  // ── product-aware additions (optional, backward compatible) ──
  product?: string;
  deliveryModel?: DeliveryModel;
  /** Description of where the probe ran ("local" or "ssh user@host"). */
  executionTarget?: string;
}

function osToPlatform(o: RemoteOs): NodeJS.Platform {
  if (o === "windows") return "win32";
  if (o === "linux") return "linux";
  if (o === "macos") return "darwin";
  // Treat "unknown" as linux so POSIX commands still get a chance — better
  // than failing loudly when uname is unavailable on a slim SSH image.
  return "linux";
}

// ──────────────────────────────────────────────────────────────────────────
// Windows probes (ctx-driven — runs via PowerShell on the *target*)
// ──────────────────────────────────────────────────────────────────────────

async function getWindowsServices(ctx: ExecutionContext, names: string[]): Promise<ServiceInfo[]> {
  if (names.length === 0) return [];
  const cmd =
    `Get-Service -Name ${psList(names)} -ErrorAction SilentlyContinue | ` +
    `Select-Object Name,Status,StartType | ConvertTo-Json -Compress`;
  const r = await ctx.runShell(cmd, { timeoutMs: 15000 });
  // NOTE: Get-Service over SSH returns exit code 1 whenever ANY requested name
  // doesn't exist (e.g. "TeamViewer_Service" is a PROCESS, not a service), even
  // with -ErrorAction SilentlyContinue — but the JSON for the services that DO
  // exist is still emitted. So parse stdout regardless of exit code; only bail
  // when stdout is genuinely empty.
  if (!r.stdout.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map((s: any) => ({
      name: String(s?.Name ?? ""),
      status: s?.Status !== undefined ? mapServiceStatus(s.Status) : undefined,
      startType: s?.StartType !== undefined ? mapServiceStartType(s.StartType) : undefined
    }));
  } catch {
    return [];
  }
}

// Get-Service serializes Status/StartType enums as their NUMERIC value when
// piped through ConvertTo-Json over SSH (e.g. 4 = Running). Map them back to
// human-readable labels so the report shows "Running"/"Automatic", not "4"/"2".
function mapServiceStatus(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  const labels: Record<number, string> = {
    1: "Stopped", 2: "StartPending", 3: "StopPending", 4: "Running",
    5: "ContinuePending", 6: "PausePending", 7: "Paused"
  };
  return Number.isFinite(n) && labels[n] ? labels[n] : String(v);
}

function mapServiceStartType(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  const labels: Record<number, string> = {
    0: "Boot", 1: "System", 2: "Automatic", 3: "Manual", 4: "Disabled"
  };
  return Number.isFinite(n) && labels[n] ? labels[n] : String(v);
}

async function getWindowsProcesses(ctx: ExecutionContext, patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const cmd =
    `Get-Process -Name ${psList(patterns.map((p) => `${p}*`))} -ErrorAction SilentlyContinue | ` +
    `Select-Object -ExpandProperty ProcessName | Sort-Object -Unique`;
  const r = await ctx.runShell(cmd, { timeoutMs: 15000 });
  // Same as services: a missing process name yields exit code 1 but valid
  // stdout for the ones that matched — parse regardless of exit code.
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function getWindowsRegistry(ctx: ExecutionContext): Promise<{ version?: string; clientId?: string }> {
  const cmd =
    `$paths=@('HKLM:\\SOFTWARE\\TeamViewer','HKLM:\\SOFTWARE\\WOW6432Node\\TeamViewer');` +
    `foreach($p in $paths){ if(Test-Path $p){ Get-ItemProperty $p | Select-Object Version,ClientID | ConvertTo-Json -Compress; break } }`;
  const r = await ctx.runShell(cmd, { timeoutMs: 15000 });
  // Tolerate a non-zero exit code as long as JSON was produced (consistent
  // with the services/processes probes — SSH PowerShell exit codes are noisy).
  if (!r.stdout.trim()) return {};
  try {
    const parsed: any = JSON.parse(r.stdout);
    return {
      version: parsed?.Version ? String(parsed.Version) : undefined,
      clientId: parsed?.ClientID ? String(parsed.ClientID) : undefined
    };
  } catch {
    return {};
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Linux probes
// ──────────────────────────────────────────────────────────────────────────

async function getLinuxServices(ctx: ExecutionContext, units: string[]): Promise<ServiceInfo[]> {
  const unitNames = units.length > 0 ? units : ["teamviewerd"];
  const out: ServiceInfo[] = [];
  for (const unit of unitNames) {
    // systemctl show never exits non-zero for a known-but-inactive unit,
    // so we get ActiveState/SubState/UnitFileState in one shot.
    const r = await ctx.runShell(
      `systemctl show ${unit} --no-page --property=ActiveState,SubState,UnitFileState,LoadState 2>/dev/null`,
      { timeoutMs: 5000 }
    );
    const text = r.stdout || "";
    if (!text.trim()) {
      // systemd absent (containers, minimal images) — try the legacy `service` wrapper.
      const fb = await ctx.runShell(`service ${unit} status 2>/dev/null`, { timeoutMs: 4000 });
      if (fb.stdout && /running|active/i.test(fb.stdout)) {
        out.push({ name: unit, status: "Running" });
      }
      continue;
    }
    const kv = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx > 0) kv.set(line.slice(0, idx), line.slice(idx + 1).trim());
    }
    if (kv.get("LoadState") === "not-found") continue;
    const active = kv.get("ActiveState");
    const sub = kv.get("SubState");
    out.push({
      name: unit,
      status: active === "active" ? "Running" : `${active ?? "unknown"}${sub ? ` (${sub})` : ""}`,
      startType: kv.get("UnitFileState")
    });
  }
  return out;
}

async function getLinuxInfo(ctx: ExecutionContext): Promise<{ version?: string; clientId?: string }> {
  for (const args of ["--info", "info"]) {
    const r = await ctx.runShell(`teamviewer ${args} 2>/dev/null`, { timeoutMs: 6000 });
    if (r.exitCode === 0 && r.stdout) {
      const idMatch = r.stdout.match(/TeamViewer ID:\s*([0-9 ]+)/i);
      const verMatch = r.stdout.match(/TeamViewer\s+v?(\d+\.\d+[\d.]*)/i) ?? r.stdout.match(/version:?\s*v?(\d+\.\d+[\d.]*)/i);
      if (idMatch || verMatch) {
        return {
          version: verMatch?.[1],
          clientId: idMatch?.[1]?.replace(/\s+/g, "") || undefined
        };
      }
    }
  }
  return {};
}

// ──────────────────────────────────────────────────────────────────────────
// macOS probes
// ──────────────────────────────────────────────────────────────────────────

async function getMacServices(ctx: ExecutionContext, names: string[]): Promise<ServiceInfo[]> {
  const r = await ctx.runShell("launchctl list 2>/dev/null", { timeoutMs: 5000 });
  if (r.exitCode !== 0 || !r.stdout) return [];
  const matcher = names.length > 0
    ? new RegExp(names.map(regexEscape).join("|"), "i")
    : /teamviewer/i;
  return r.stdout
    .split(/\r?\n/)
    .filter((line) => matcher.test(line))
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return { name: parts[2] ?? "teamviewer", status: parts[1] === "0" ? "Running" : `exit ${parts[1]}` };
    });
}

async function getMacInfo(ctx: ExecutionContext): Promise<{ version?: string; clientId?: string }> {
  const r = await ctx.runShell(
    `defaults read /Applications/TeamViewer.app/Contents/Info CFBundleShortVersionString 2>/dev/null`,
    { timeoutMs: 4000 }
  );
  const version = r.stdout.trim();
  return version ? { version } : {};
}

// ──────────────────────────────────────────────────────────────────────────
// POSIX shared probes
// ──────────────────────────────────────────────────────────────────────────

async function getPosixProcesses(ctx: ExecutionContext, patterns: string[]): Promise<string[]> {
  const pattern = patterns.length > 0
    ? patterns.map(regexEscape).join("|")
    : "teamviewer";
  // pgrep -l prints "<pid> <name>"; -i case-insensitive; -f matches full cmdline.
  const r = await ctx.runShell(`pgrep -l -f -i '${pattern.replace(/'/g, "'\\''")}' 2>/dev/null`, { timeoutMs: 5000 });
  if (r.exitCode !== 0 || !r.stdout) return [];
  const names = new Set<string>();
  for (const line of r.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    // pgrep -lf prints "<pid> <cmd> <args...>" — keep the basename of the cmd.
    const cmd = parts[1];
    if (!cmd) continue;
    const base = cmd.split(/[\\/]/).pop() ?? cmd;
    names.add(base);
  }
  return [...names].sort();
}

// ──────────────────────────────────────────────────────────────────────────
// Host info (hostname / uptime / memory)
// ──────────────────────────────────────────────────────────────────────────

interface HostInfo {
  hostname: string;
  osRelease: string;
  uptimeSec: number;
  freeMemMb: number;
  totalMemMb: number;
}

async function gatherHostInfoLocal(): Promise<HostInfo> {
  return {
    hostname: os.hostname(),
    osRelease: os.release(),
    uptimeSec: Math.round(os.uptime()),
    freeMemMb: Math.round(os.freemem() / 1024 / 1024),
    totalMemMb: Math.round(os.totalmem() / 1024 / 1024)
  };
}

async function gatherHostInfoRemote(ctx: ExecutionContext): Promise<HostInfo> {
  // Best-effort remote host metrics. Failures are tolerated — missing values
  // surface as 0 so the report renderer can still summarize the run.
  let hostname = "remote";
  let osRelease = "";
  let uptimeSec = 0;
  let freeMemMb = 0;
  let totalMemMb = 0;

  if (ctx.os === "windows") {
    // Windows hosts speak PowerShell, not POSIX: `hostname`/`uname`/`/proc/*`
    // all fail there. Pull hostname, OS build, uptime and memory from CIM in a
    // single pipe-delimited line so the parse is trivial and shell-agnostic.
    const cmd =
      `$o=Get-CimInstance Win32_OperatingSystem;` +
      `$up=[int]((Get-Date) - $o.LastBootUpTime).TotalSeconds;` +
      `$free=[int]($o.FreePhysicalMemory/1024);` +
      `$total=[int]($o.TotalVisibleMemorySize/1024);` +
      `"$($env:COMPUTERNAME)|$([System.Environment]::OSVersion.Version.ToString())|$up|$free|$total"`;
    const r = await ctx.runShell(cmd, { timeoutMs: 15000 });
    const parts = (r.stdout || "").trim().split("|");
    if (parts.length >= 5) {
      hostname = parts[0] || "remote";
      osRelease = parts[1] || "";
      uptimeSec = parseInt(parts[2], 10) || 0;
      freeMemMb = parseInt(parts[3], 10) || 0;
      totalMemMb = parseInt(parts[4], 10) || 0;
    }
    return { hostname, osRelease, uptimeSec, freeMemMb, totalMemMb };
  }

  const hn = await ctx.runShell("hostname 2>/dev/null", { timeoutMs: 4000 });
  if (hn.exitCode === 0 && hn.stdout) hostname = hn.stdout.trim().split(/\s+/)[0] ?? "remote";

  const rel = await ctx.runShell("uname -r 2>/dev/null", { timeoutMs: 4000 });
  if (rel.exitCode === 0 && rel.stdout) osRelease = rel.stdout.trim();

  if (ctx.os === "macos") {
    const up = await ctx.runShell(`sysctl -n kern.boottime 2>/dev/null | awk -F'[= ,]' '{print $6}'`, { timeoutMs: 4000 });
    const boot = parseInt((up.stdout || "").trim(), 10);
    if (!isNaN(boot) && boot > 0) {
      uptimeSec = Math.max(0, Math.round(Date.now() / 1000 - boot));
    }
    const mem = await ctx.runShell(
      `sysctl -n hw.memsize 2>/dev/null; pagesize=$(/usr/bin/pagesize 2>/dev/null || echo 4096); ` +
        `vm_stat 2>/dev/null | awk -v ps=$pagesize '/Pages free/ {gsub(/\\./,"",$3); print $3*ps}'`,
      { timeoutMs: 5000 }
    );
    const lines = (mem.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines[0]) totalMemMb = Math.round(parseInt(lines[0], 10) / 1024 / 1024) || 0;
    if (lines[1]) freeMemMb = Math.round(parseInt(lines[1], 10) / 1024 / 1024) || 0;
  } else {
    const up = await ctx.runShell(`awk '{print int($1)}' /proc/uptime 2>/dev/null`, { timeoutMs: 4000 });
    const s = parseInt((up.stdout || "").trim(), 10);
    if (!isNaN(s)) uptimeSec = s;
    const mem = await ctx.runShell(
      `awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {print t" "a}' /proc/meminfo 2>/dev/null`,
      { timeoutMs: 4000 }
    );
    const [tot, avail] = (mem.stdout || "").trim().split(/\s+/).map((n) => parseInt(n, 10));
    if (!isNaN(tot)) totalMemMb = Math.round(tot / 1024);
    if (!isNaN(avail)) freeMemMb = Math.round(avail / 1024);
  }

  return { hostname, osRelease, uptimeSec, freeMemMb, totalMemMb };
}

// ──────────────────────────────────────────────────────────────────────────
// Public entrypoint
// ──────────────────────────────────────────────────────────────────────────

export async function runEndpointHealthProbe(
  profile: ProductDiagnosticProfile = getProductProfile("teamviewer-remote"),
  ctx: ExecutionContext = new LocalContext()
): Promise<EndpointHealthReport> {
  const diagnostics: string[] = [];
  let services: ServiceInfo[] = [];
  let processes: string[] = [];
  let reg: { version?: string; clientId?: string } = {};
  const label = profile.name;
  const cloudOnly = profile.deliveryModel === "cloud-or-mobile";

  if (ctx.os === "windows") {
    [services, processes, reg] = await Promise.all([
      getWindowsServices(ctx, profile.services.win32),
      getWindowsProcesses(ctx, profile.processes.win32),
      getWindowsRegistry(ctx)
    ]);
    if (services.length === 0) diagnostics.push(`No ${label} services found (Get-Service returned empty).`);
    else {
      const stopped = services.filter((s) => s.status && s.status !== "Running");
      if (stopped.length > 0) diagnostics.push(`Stopped ${label} services: ${stopped.map((s) => s.name).join(", ")}`);
    }
    if (processes.length === 0) diagnostics.push(`No ${label} processes running.`);
    if (!reg.version) diagnostics.push("TeamViewer not detected in HKLM registry (uninstalled or non-standard path).");
  } else if (ctx.os === "linux") {
    [services, processes, reg] = await Promise.all([
      getLinuxServices(ctx, profile.services.linux),
      getPosixProcesses(ctx, profile.processes.linux),
      getLinuxInfo(ctx)
    ]);
    if (services.length === 0) diagnostics.push(`${label} service unit not found (uninstalled or not managed by systemd).`);
    else {
      const stopped = services.filter((s) => s.status && s.status !== "Running");
      if (stopped.length > 0) diagnostics.push(`${label} service not running: ${stopped.map((s) => s.status).join(", ")}`);
    }
    if (processes.length === 0) diagnostics.push(`No ${label} processes running (pgrep found none).`);
    if (!reg.version && !reg.clientId) diagnostics.push("`teamviewer --info` unavailable (CLI not on PATH or daemon down).");
  } else if (ctx.os === "macos") {
    [services, processes, reg] = await Promise.all([
      getMacServices(ctx, profile.services.darwin),
      getPosixProcesses(ctx, profile.processes.darwin),
      getMacInfo(ctx)
    ]);
    if (services.length === 0) diagnostics.push(`No ${label} launch agents/daemons registered with launchctl.`);
    if (processes.length === 0) diagnostics.push(`No ${label} processes running (pgrep found none).`);
    if (!reg.version) diagnostics.push("TeamViewer.app not found under /Applications (non-standard install path).");
  } else {
    services = [];
    diagnostics.push(`Endpoint probing is not implemented for OS '${ctx.os}'.`);
  }

  // For cloud-/mobile-first products, the absence of a host agent is EXPECTED.
  if (cloudOnly && services.length === 0 && processes.length === 0) {
    diagnostics.push(
      `${label} is delivered via cloud/mobile; no host agent is expected on this machine — diagnose via connectivity + Web API instead.`
    );
  }

  const hostInfo = ctx.kind === "local" ? await gatherHostInfoLocal() : await gatherHostInfoRemote(ctx);

  return {
    platform: osToPlatform(ctx.os),
    ...hostInfo,
    services,
    processes,
    installedVersion: reg.version,
    clientId: reg.clientId,
    diagnostics,
    product: profile.name,
    deliveryModel: profile.deliveryModel,
    executionTarget: ctx.description
  };
}
