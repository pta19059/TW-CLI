// Real endpoint-health probes with first-class coverage for Windows, Linux and
// macOS — TeamViewer ships on all three, and the CLI may run anywhere the agent
// is installed (on-prem or any cloud). Each platform reports service state,
// running processes and the installed version / client id where available.

import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export interface ServiceInfo {
  name: string;
  status?: string;
  startType?: string;
}

export interface EndpointHealthReport {
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
}

async function getWindowsServices(): Promise<ServiceInfo[]> {
  try {
    const { stdout } = await pExecFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Service -Name 'TeamViewer','TeamViewer_Service' -ErrorAction SilentlyContinue | Select-Object Name,Status,StartType | ConvertTo-Json -Compress"
      ],
      { timeout: 5000, windowsHide: true }
    );
    if (!stdout.trim()) return [];
    const parsed: unknown = JSON.parse(stdout);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map((r: any) => ({
      name: String(r?.Name ?? ""),
      status: r?.Status !== undefined ? String(r.Status) : undefined,
      startType: r?.StartType !== undefined ? String(r.StartType) : undefined
    }));
  } catch {
    return [];
  }
}

async function getWindowsProcesses(): Promise<string[]> {
  try {
    const { stdout } = await pExecFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process -Name 'TeamViewer*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique"
      ],
      { timeout: 5000, windowsHide: true }
    );
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function getWindowsRegistry(): Promise<{ version?: string; clientId?: string }> {
  try {
    const { stdout } = await pExecFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$paths=@('HKLM:\\SOFTWARE\\TeamViewer','HKLM:\\SOFTWARE\\WOW6432Node\\TeamViewer');" +
          "foreach($p in $paths){ if(Test-Path $p){ Get-ItemProperty $p | Select-Object Version,ClientID | ConvertTo-Json -Compress; break } }"
      ],
      { timeout: 5000, windowsHide: true }
    );
    if (!stdout.trim()) return {};
    const parsed: any = JSON.parse(stdout);
    return {
      version: parsed?.Version ? String(parsed.Version) : undefined,
      clientId: parsed?.ClientID ? String(parsed.ClientID) : undefined
    };
  } catch {
    return {};
  }
}

async function getLinuxServices(): Promise<ServiceInfo[]> {
  // `systemctl show` never exits non-zero for a known-but-inactive unit, so we
  // get ActiveState/SubState/UnitFileState in one shot without throwing.
  try {
    const { stdout } = await pExecFile(
      "systemctl",
      ["show", "teamviewerd", "--no-page", "--property=ActiveState,SubState,UnitFileState,LoadState"],
      { timeout: 4000 }
    );
    const kv = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx > 0) kv.set(line.slice(0, idx), line.slice(idx + 1).trim());
    }
    if (kv.get("LoadState") === "not-found") return [];
    const active = kv.get("ActiveState"); // active | inactive | failed
    const sub = kv.get("SubState"); // running | dead | ...
    return [
      {
        name: "teamviewerd",
        status: active === "active" ? "Running" : `${active ?? "unknown"}${sub ? ` (${sub})` : ""}`,
        startType: kv.get("UnitFileState") // enabled | disabled | static
      }
    ];
  } catch {
    // systemd absent (containers, minimal images) — fall back to a liveness probe.
    try {
      const { stdout } = await pExecFile("service", ["teamviewerd", "status"], { timeout: 4000 });
      return [{ name: "teamviewerd", status: /running|active/i.test(stdout) ? "Running" : "Stopped" }];
    } catch {
      return [];
    }
  }
}

async function getMacServices(): Promise<ServiceInfo[]> {
  try {
    const { stdout } = await pExecFile("launchctl", ["list"], { timeout: 4000 });
    return stdout
      .split(/\r?\n/)
      .filter((line) => /teamviewer/i.test(line))
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return { name: parts[2] ?? "teamviewer", status: parts[1] === "0" ? "Running" : `exit ${parts[1]}` };
      });
  } catch {
    return [];
  }
}

async function getPosixProcesses(): Promise<string[]> {
  // `pgrep -l` prints "<pid> <name>"; available on both Linux and macOS.
  try {
    const { stdout } = await pExecFile("pgrep", ["-l", "-i", "teamviewer"], { timeout: 4000 });
    const names = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      const name = line.trim().split(/\s+/)[1];
      if (name) names.add(name);
    }
    return [...names].sort();
  } catch {
    return [];
  }
}

async function getLinuxInfo(): Promise<{ version?: string; clientId?: string }> {
  // `teamviewer --info` (or `info`) reports the version and the TeamViewer ID.
  for (const args of [["--info"], ["info"]]) {
    try {
      const { stdout } = await pExecFile("teamviewer", args, { timeout: 5000 });
      const idMatch = stdout.match(/TeamViewer ID:\s*([0-9 ]+)/i);
      const verMatch = stdout.match(/TeamViewer\s+v?(\d+\.\d+[\d.]*)/i) ?? stdout.match(/version:?\s*v?(\d+\.\d+[\d.]*)/i);
      if (idMatch || verMatch) {
        return {
          version: verMatch?.[1],
          clientId: idMatch?.[1]?.replace(/\s+/g, "") || undefined
        };
      }
    } catch {
      /* try next form */
    }
  }
  return {};
}

async function getMacInfo(): Promise<{ version?: string; clientId?: string }> {
  try {
    const { stdout } = await pExecFile(
      "defaults",
      ["read", "/Applications/TeamViewer.app/Contents/Info", "CFBundleShortVersionString"],
      { timeout: 4000 }
    );
    const version = stdout.trim();
    return version ? { version } : {};
  } catch {
    return {};
  }
}

export async function runEndpointHealthProbe(): Promise<EndpointHealthReport> {
  const diagnostics: string[] = [];
  let services: ServiceInfo[] = [];
  let processes: string[] = [];
  let reg: { version?: string; clientId?: string } = {};

  if (process.platform === "win32") {
    [services, processes, reg] = await Promise.all([
      getWindowsServices(),
      getWindowsProcesses(),
      getWindowsRegistry()
    ]);
    if (services.length === 0) diagnostics.push("No TeamViewer services found (Get-Service returned empty).");
    else {
      const stopped = services.filter((s) => s.status && s.status !== "Running");
      if (stopped.length > 0) diagnostics.push(`Stopped TeamViewer services: ${stopped.map((s) => s.name).join(", ")}`);
    }
    if (processes.length === 0) diagnostics.push("No TeamViewer*.exe processes running.");
    if (!reg.version) diagnostics.push("TeamViewer not detected in HKLM registry (uninstalled or non-standard path).");
  } else if (process.platform === "linux") {
    [services, processes, reg] = await Promise.all([getLinuxServices(), getPosixProcesses(), getLinuxInfo()]);
    if (services.length === 0) diagnostics.push("teamviewerd service unit not found (uninstalled or not managed by systemd).");
    else {
      const stopped = services.filter((s) => s.status && s.status !== "Running");
      if (stopped.length > 0) diagnostics.push(`teamviewerd not running: ${stopped.map((s) => s.status).join(", ")}`);
    }
    if (processes.length === 0) diagnostics.push("No teamviewer processes running (pgrep found none).");
    if (!reg.version && !reg.clientId) diagnostics.push("`teamviewer --info` unavailable (CLI not on PATH or daemon down).");
  } else if (process.platform === "darwin") {
    [services, processes, reg] = await Promise.all([getMacServices(), getPosixProcesses(), getMacInfo()]);
    if (services.length === 0) diagnostics.push("No TeamViewer launch agents/daemons registered with launchctl.");
    if (processes.length === 0) diagnostics.push("No TeamViewer processes running (pgrep found none).");
    if (!reg.version) diagnostics.push("TeamViewer.app not found under /Applications (non-standard install path).");
  } else {
    services = [];
    diagnostics.push(`Endpoint probing is not implemented for platform '${process.platform}'.`);
  }

  return {
    platform: process.platform,
    osRelease: os.release(),
    hostname: os.hostname(),
    freeMemMb: Math.round(os.freemem() / 1024 / 1024),
    totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    uptimeSec: Math.round(os.uptime()),
    services,
    processes,
    installedVersion: reg.version,
    clientId: reg.clientId,
    diagnostics
  };
}
