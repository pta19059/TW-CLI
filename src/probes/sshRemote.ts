import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface SshOptions {
  /** Target IP or hostname. */
  host: string;
  /** SSH user on the remote host. */
  user: string;
  /** SSH port (default 22). */
  port?: number;
  /** Path to a private key (default = ssh agent / ~/.ssh/id_*). */
  identity?: string;
  /** Per-command timeout (ms). Default 8000. */
  timeoutMs?: number;
}

export interface RemoteCheck {
  /** Short label shown in the report. */
  label: string;
  /** Remote command actually executed. */
  command: string;
  /** Captured stdout (trimmed). Empty string if the command failed. */
  stdout: string;
  /** Captured stderr (trimmed). */
  stderr: string;
  /** Process exit code (0 = success). null = transport-level error. */
  exitCode: number | null;
  /** Wall-clock duration. */
  ms: number;
}

export interface MacDiagnostics {
  host: string;
  user: string;
  reachableSsh: boolean;
  checks: RemoteCheck[];
}

/** Curated, read-only command set for inspecting TeamViewer on macOS. */
export const MAC_INSPECTION_COMMANDS: { label: string; command: string }[] = [
  { label: "macOS version", command: "sw_vers" },
  { label: "Hostname & uptime", command: "hostname && uptime" },
  { label: "Network interfaces (IPv4 only)", command: "ifconfig | awk '/inet / && $2 != \"127.0.0.1\"{print $1\" \"$2}'" },
  { label: "TeamViewer app version", command: "defaults read /Applications/TeamViewer.app/Contents/Info CFBundleShortVersionString 2>/dev/null || echo 'TeamViewer.app not found in /Applications'" },
  { label: "TeamViewer daemon on port 5938", command: "sudo -n lsof -nP -iTCP:5938 -sTCP:LISTEN 2>/dev/null || lsof -nP -iTCP:5938 -sTCP:LISTEN 2>/dev/null || echo 'lsof returned nothing (port not in LISTEN or insufficient privileges)'" },
  { label: "TeamViewer launchd jobs", command: "launchctl list 2>/dev/null | grep -i teamview || echo 'no launchd entries for teamviewer'" },
  { label: "TeamViewer running processes", command: "pgrep -lf -i teamviewer || echo 'no teamviewer processes running'" },
  { label: "Latest TeamViewer logfile (last 40 lines)", command: "ls -t \"$HOME/Library/Logs/TeamViewer/\"TeamViewer*_Logfile*.log 2>/dev/null | head -1 | xargs -I{} tail -40 \"{}\" 2>/dev/null || echo 'no TeamViewer log files found'" },
  { label: "Outbound reachability to TeamViewer cloud", command: "for h in router1.teamviewer.com router7.teamviewer.com master1.teamviewer.com; do /usr/bin/nc -z -G 3 $h 5938 && echo \"$h:5938 OPEN\" || echo \"$h:5938 FAIL\"; done" },
  { label: "Public IP (NAT-side)", command: "curl -fsS --max-time 5 https://api.ipify.org || echo 'public IP lookup failed'" }
];

function buildSshArgs(opts: SshOptions, remoteCommand: string): string[] {
  const args: string[] = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
    "-p", String(opts.port ?? 22)
  ];
  if (opts.identity) {
    args.push("-i", opts.identity);
  }
  args.push(`${opts.user}@${opts.host}`);
  args.push(remoteCommand);
  return args;
}

async function runOne(opts: SshOptions, label: string, command: string): Promise<RemoteCheck> {
  const t0 = Date.now();
  const args = buildSshArgs(opts, command);
  try {
    const { stdout, stderr } = await execFileP("ssh", args, {
      timeout: opts.timeoutMs ?? 8000,
      maxBuffer: 2 * 1024 * 1024
    });
    return {
      label,
      command,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
      ms: Date.now() - t0
    };
  } catch (err: unknown) {
    const e = err as { code?: number; signal?: string; stdout?: string; stderr?: string; message?: string };
    return {
      label,
      command,
      stdout: (e.stdout ?? "").toString().trim(),
      stderr: (e.stderr ?? e.message ?? "").toString().trim(),
      exitCode: typeof e.code === "number" ? e.code : null,
      ms: Date.now() - t0
    };
  }
}

/** Probe SSH reachability with a no-op command before running the full battery. */
async function probeReachability(opts: SshOptions): Promise<RemoteCheck> {
  return runOne(opts, "SSH reachability", "echo __twc_ssh_ok__");
}

/** Run the full mac inspection over SSH. Commands run sequentially to keep ordering deterministic. */
export async function runMacInspection(opts: SshOptions): Promise<MacDiagnostics> {
  const reach = await probeReachability(opts);
  const reachableSsh = reach.exitCode === 0 && reach.stdout.includes("__twc_ssh_ok__");
  if (!reachableSsh) {
    return { host: opts.host, user: opts.user, reachableSsh: false, checks: [reach] };
  }
  const checks: RemoteCheck[] = [reach];
  for (const step of MAC_INSPECTION_COMMANDS) {
    checks.push(await runOne(opts, step.label, step.command));
  }
  return { host: opts.host, user: opts.user, reachableSsh: true, checks };
}

/** Compact human-readable rendering used by the CLI. */
export function renderMacDiagnostics(diag: MacDiagnostics): string {
  const lines: string[] = [];
  lines.push(`SSH target: ${diag.user}@${diag.host}`);
  lines.push(`SSH reachable: ${diag.reachableSsh ? "yes" : "no"}`);
  if (!diag.reachableSsh) {
    const reach = diag.checks[0];
    lines.push("");
    lines.push("Reachability probe failed:");
    if (reach.stderr) lines.push(`  stderr: ${reach.stderr.split("\n").slice(0, 3).join(" | ")}`);
    lines.push(`  exitCode: ${reach.exitCode}`);
    lines.push("");
    lines.push("Hints:");
    lines.push("  - Enable Remote Login on the Mac: System Settings -> General -> Sharing -> Remote Login.");
    lines.push("  - Copy your public key: ssh-copy-id <user>@<host> (or append id_ed25519.pub to ~/.ssh/authorized_keys).");
    lines.push("  - Confirm: ssh -o BatchMode=yes <user>@<host> echo ok");
    return lines.join("\n");
  }
  lines.push("");
  for (const c of diag.checks) {
    if (c.label === "SSH reachability") continue;
    lines.push(`── ${c.label}  (${c.ms}ms${c.exitCode === 0 ? "" : `, exit=${c.exitCode ?? "n/a"}`})`);
    const body = c.stdout || c.stderr || "(no output)";
    for (const ln of body.split("\n").slice(0, 12)) lines.push(`   ${ln}`);
  }
  return lines.join("\n");
}
