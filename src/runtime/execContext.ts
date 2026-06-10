// ExecutionContext — uniform shell-execution abstraction so the probes can
// run identically on the local machine OR on a remote SSH host OR on a
// cloud VM (no SSH required) OR inside a Kubernetes pod.
//
// Why this exists
// ───────────────
// Before this layer, every probe called `execFile("powershell"/"systemctl"/...)`
// directly and branched on `process.platform`. That hard-coded the diagnostic
// to the machine the CLI runs on. With ExecutionContext the probes only need
// to know:
//   • ctx.os       → which command set to use (windows | linux | macos)
//   • ctx.runShell → how to execute a shell command and read back stdout/stderr
//   • ctx.readFile → how to read a text file (used by the log harvester)
//
// Implementations:
//   • LocalContext              — Node child_process / fs on the host.
//   • SshContext                — `ssh -n -o BatchMode=yes …` for every command
//                                 (POSIX targets: raw shell; Windows targets:
//                                 PowerShell wrapped via -EncodedCommand to
//                                 sidestep cmd.exe escaping).
//   • AzureRunCommandContext    — `az vm run-command invoke` over ARM HTTPS,
//                                 no inbound port required on the VM.
//   • KubectlExecContext        — `kubectl exec` into a pod (always treated
//                                 as Linux — Windows pods are out of scope).
//
// New probes should ONLY use ctx.runShell / ctx.readFile — never `execFile`
// or `fs.*` directly — otherwise they break for remote/cloud targets.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export type RemoteOs = "windows" | "linux" | "macos" | "unknown";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Wall-clock duration in milliseconds. */
  ms: number;
}

export interface ShellOptions {
  /** Per-command timeout (ms). Default 8000. */
  timeoutMs?: number;
  /** Max stdout/stderr buffer in bytes. Default 2 MB. */
  maxBuffer?: number;
}

export interface DirEntry {
  name: string;
  /** Full POSIX-style or Windows-style path joined under the parent. */
  path: string;
  /** File size in bytes if known. -1 if unknown (remote ls without -l). */
  size: number;
  /** True when the entry is a regular file. False = directory / link / unknown. */
  isFile: boolean;
}

export interface ExecutionContext {
  /** "local" for on-host, "ssh" for SSH-remote, "azure-vm" for Azure RunCommand, "k8s" for kubectl exec. */
  readonly kind: "local" | "ssh" | "azure-vm" | "k8s";
  /** OS of the *target* (not the runner). Detected lazily for remote contexts. */
  readonly os: RemoteOs;
  /** Human label used in reports: "local" / "ssh user@host" / "azure-vm rg/name" / "k8s ns/pod". */
  readonly description: string;
  /** Run a shell command on the target and capture stdout/stderr/exitCode. */
  runShell(command: string, opts?: ShellOptions): Promise<ShellResult>;
  /** Read the first N bytes (default 256 KB) of a text file on the target. */
  readFile(path: string, maxBytes?: number): Promise<string>;
  /** List files in a directory on the target. */
  listDir(path: string): Promise<DirEntry[]>;
  /** True when the file/dir exists on the target. */
  pathExists(path: string): Promise<boolean>;
}

// ───────────────────────────── LocalContext ─────────────────────────────

function platformToOs(p: NodeJS.Platform): RemoteOs {
  if (p === "win32") return "windows";
  if (p === "linux") return "linux";
  if (p === "darwin") return "macos";
  return "unknown";
}

export class LocalContext implements ExecutionContext {
  readonly kind = "local" as const;
  readonly os: RemoteOs;
  readonly description = "local";

  constructor() {
    this.os = platformToOs(process.platform);
  }

  async runShell(command: string, opts: ShellOptions = {}): Promise<ShellResult> {
    const t0 = Date.now();
    const timeout = opts.timeoutMs ?? 8000;
    const maxBuffer = opts.maxBuffer ?? 2 * 1024 * 1024;
    // On Windows we route through powershell.exe so commands like
    // `Get-Service`, redirections and `;` chaining work uniformly with what
    // a probe author would write. On POSIX we use /bin/sh.
    try {
      let stdout: string;
      let stderr: string;
      if (this.os === "windows") {
        const r = await pExecFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", command],
          { timeout, maxBuffer, windowsHide: true }
        );
        stdout = r.stdout;
        stderr = r.stderr;
      } else {
        const r = await pExecFile("/bin/sh", ["-c", command], { timeout, maxBuffer });
        stdout = r.stdout;
        stderr = r.stderr;
      }
      return { stdout: String(stdout), stderr: String(stderr), exitCode: 0, ms: Date.now() - t0 };
    } catch (err: unknown) {
      const e = err as { code?: number; signal?: string; stdout?: string; stderr?: string; message?: string };
      return {
        stdout: String(e.stdout ?? "").trim(),
        stderr: String(e.stderr ?? e.message ?? "").trim(),
        exitCode: typeof e.code === "number" ? e.code : null,
        ms: Date.now() - t0
      };
    }
  }

  async readFile(filePath: string, maxBytes = 256 * 1024): Promise<string> {
    try {
      const stat = statSync(filePath);
      if (stat.size <= maxBytes) {
        return readFileSync(filePath, "utf-8");
      }
      // Tail-read for large files (avoids loading multi-MB logs in full).
      const fs = await import("node:fs");
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
        return buf.toString("utf-8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "";
    }
  }

  async listDir(dirPath: string): Promise<DirEntry[]> {
    try {
      return readdirSync(dirPath, { withFileTypes: true }).map((d) => {
        const full = `${dirPath}${dirPath.endsWith("/") || dirPath.endsWith("\\") ? "" : "/"}${d.name}`;
        let size = -1;
        try { size = statSync(full).size; } catch { /* unreadable, leave -1 */ }
        return { name: d.name, path: full, size, isFile: d.isFile() };
      });
    } catch {
      return [];
    }
  }

  async pathExists(filePath: string): Promise<boolean> {
    return existsSync(filePath);
  }
}

// ───────────────────────────── SshContext ─────────────────────────────

export interface SshConnectionOptions {
  /** Target hostname or IPv4. */
  host: string;
  /** Remote username. */
  user: string;
  /** SSH port (default 22). */
  port?: number;
  /** Optional explicit identity file (otherwise the ssh agent / default key is used). */
  identity?: string;
  /** Per-command timeout in ms. Default 8000. */
  defaultTimeoutMs?: number;
}

/**
 * Build the argv for `ssh`. Centralised here so every remote command picks
 * up the hardened defaults (the `-n` flag in particular is critical on
 * Windows OpenSSH: without it, ssh inherits Node's stdin and hangs until the
 * per-command timeout fires).
 */
function buildSshArgs(opts: SshConnectionOptions, remoteCommand: string): string[] {
  const args: string[] = [
    "-n",
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

export class SshContext implements ExecutionContext {
  readonly kind = "ssh" as const;
  os: RemoteOs;
  readonly description: string;
  private readonly opts: SshConnectionOptions;

  private constructor(opts: SshConnectionOptions, os: RemoteOs) {
    this.opts = opts;
    this.os = os;
    this.description = `ssh ${opts.user}@${opts.host}${opts.port && opts.port !== 22 ? `:${opts.port}` : ""}`;
  }

  /**
   * Create an SshContext and detect the remote OS up-front.
   * Two-stage probe so Windows OpenSSH targets (where `uname` is not
   * recognised by cmd.exe / pwsh) are still classified correctly:
   *   1. POSIX probe: `uname -s` — succeeds on Linux/macOS.
   *   2. Fallback Windows probe: `powershell … "[System.Environment]::OSVersion.VersionString"`
   *      — prints e.g. "Microsoft Windows NT 10.0.19045.0" on EVERY Windows
   *      PowerShell (5.1 built-in) *and* PowerShell 7+. NOTE: do NOT use
   *      `$PSVersionTable.OS` here — that property only exists on PowerShell
   *      Core 6+, so it returns EMPTY on the in-box Windows PowerShell 5.1 that
   *      ships with Windows 10/11/Server, leaving the host misdetected as
   *      "unknown" and the POSIX command set wrongly sent to cmd.exe.
   */
  static async connect(opts: SshConnectionOptions): Promise<SshContext> {
    let os: RemoteOs = "unknown";

    const posix = await SshContext.execOnce(opts, "uname -s", 6000);
    const posixOut = posix.stdout.trim().toLowerCase();
    if (posix.exitCode === 0 && posixOut) {
      if (posixOut.includes("darwin")) os = "macos";
      else if (posixOut.includes("linux")) os = "linux";
      else if (posixOut.includes("mingw") || posixOut.includes("msys") || posixOut.includes("cygwin")) os = "windows";
    }

    if (os === "unknown") {
      // Try PowerShell. Works whether the SSH default shell is cmd.exe or pwsh.
      // OSVersion.VersionString is present on Windows PowerShell 5.1 AND 7+,
      // unlike $PSVersionTable.OS which is PS-Core-only (empty on 5.1).
      const win = await SshContext.execOnce(
        opts,
        `powershell -NoLogo -NoProfile -NonInteractive -Command "[System.Environment]::OSVersion.VersionString"`,
        8000
      );
      const winOut = (win.stdout + win.stderr).toLowerCase();
      if (winOut.includes("windows") || winOut.includes("microsoft")) {
        os = "windows";
      }
    }

    // Note: connection failures still produce a context with os=unknown so
    // the caller can surface a clean error from the first probe rather than
    // crashing during construction.
    return new SshContext(opts, os);
  }

  /** Internal: one-shot ssh invocation used by `connect()` before the instance exists. */
  private static async execOnce(opts: SshConnectionOptions, cmd: string, timeoutMs: number): Promise<ShellResult> {
    const t0 = Date.now();
    try {
      const r = await pExecFile("ssh", buildSshArgs(opts, cmd), {
        timeout: timeoutMs,
        maxBuffer: 1 * 1024 * 1024
      });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: 0, ms: Date.now() - t0 };
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        stdout: String(e.stdout ?? "").trim(),
        stderr: String(e.stderr ?? e.message ?? "").trim(),
        exitCode: typeof e.code === "number" ? e.code : null,
        ms: Date.now() - t0
      };
    }
  }

  async runShell(command: string, opts: ShellOptions = {}): Promise<ShellResult> {
    const t0 = Date.now();
    const timeout = opts.timeoutMs ?? this.opts.defaultTimeoutMs ?? 8000;
    const maxBuffer = opts.maxBuffer ?? 2 * 1024 * 1024;
    // Windows targets: wrap as `powershell -EncodedCommand <base64-utf16le>`.
    // This bypasses ALL cmd.exe / quoting hell — the script payload is opaque
    // to whatever shell ssh hands to powershell.exe on the remote side.
    const wire = this.os === "windows" ? encodePwshOverSsh(command) : command;
    try {
      const r = await pExecFile("ssh", buildSshArgs(this.opts, wire), { timeout, maxBuffer });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: 0, ms: Date.now() - t0 };
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        stdout: String(e.stdout ?? "").trim(),
        stderr: String(e.stderr ?? e.message ?? "").trim(),
        exitCode: typeof e.code === "number" ? e.code : null,
        ms: Date.now() - t0
      };
    }
  }

  async readFile(filePath: string, maxBytes = 256 * 1024): Promise<string> {
    if (this.os === "windows") {
      // PowerShell tail-read: seek to (size - maxBytes), read remainder.
      const q = pwshQuote(filePath);
      const script =
        `$ErrorActionPreference='SilentlyContinue';` +
        `if(-not (Test-Path -LiteralPath ${q})){ return };` +
        `$fi=Get-Item -LiteralPath ${q};` +
        `$max=${maxBytes};` +
        `$fs=[IO.File]::OpenRead($fi.FullName);` +
        `try{` +
        `  if($fi.Length -gt $max){ [void]$fs.Seek($fi.Length - $max,'Begin') };` +
        `  $len=[Math]::Min([int64]$fi.Length,[int64]$max);` +
        `  $buf=New-Object byte[] $len;` +
        `  [void]$fs.Read($buf,0,$len);` +
        `  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($buf))` +
        `}finally{ $fs.Dispose() }`;
      const r = await this.runShell(script, { timeoutMs: 12000, maxBuffer: maxBytes + 64 * 1024 });
      return r.exitCode === 0 ? r.stdout : "";
    }
    // POSIX: `tail -c` to bounded-read remote files.
    const quoted = singleQuote(filePath);
    const r = await this.runShell(`tail -c ${maxBytes} ${quoted} 2>/dev/null || true`);
    return r.exitCode === 0 ? r.stdout : "";
  }

  async listDir(dirPath: string): Promise<DirEntry[]> {
    if (this.os === "windows") {
      const q = pwshQuote(dirPath);
      const script =
        `$ErrorActionPreference='SilentlyContinue';` +
        `if(-not (Test-Path -LiteralPath ${q})){ return };` +
        `Get-ChildItem -LiteralPath ${q} -Force | ForEach-Object {` +
        `  $isFile = -not $_.PSIsContainer;` +
        `  $size = if($isFile){ [int64]$_.Length } else { -1 };` +
        `  '{0}\t{1}\t{2}\t{3}' -f ($(if($isFile){'F'}else{'D'})), $size, $_.Name, $_.FullName` +
        `}`;
      const r = await this.runShell(script, { timeoutMs: 10000 });
      if (r.exitCode !== 0 || !r.stdout) return [];
      const out: DirEntry[] = [];
      for (const line of r.stdout.split(/\r?\n/)) {
        const parts = line.split("\t");
        if (parts.length < 4) continue;
        const [kind, sizeStr, name, full] = parts;
        const size = parseInt(sizeStr, 10);
        out.push({
          name: (name ?? "").trim(),
          path: (full ?? "").trim(),
          size: isNaN(size) ? -1 : size,
          isFile: kind === "F"
        });
      }
      return out.filter((e) => e.name);
    }
    const quoted = singleQuote(dirPath);
    // Tab-separated: <size>\t<name>; -L follows symlinks for size accuracy.
    const r = await this.runShell(
      `ls -L1A ${quoted} 2>/dev/null | while IFS= read -r f; do printf "%s\\t%s\\n" "$(stat -c%s "${quoted}/$f" 2>/dev/null || stat -f%z "${quoted}/$f" 2>/dev/null || echo -1)" "$f"; done`
    );
    if (r.exitCode !== 0 || !r.stdout) return [];
    const out: DirEntry[] = [];
    for (const line of r.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const size = parseInt(line.slice(0, tab), 10);
      const name = line.slice(tab + 1).trim();
      if (!name) continue;
      out.push({ name, path: `${dirPath.replace(/\/+$/, "")}/${name}`, size: isNaN(size) ? -1 : size, isFile: !isNaN(size) && size >= 0 });
    }
    return out;
  }

  async pathExists(filePath: string): Promise<boolean> {
    if (this.os === "windows") {
      const q = pwshQuote(filePath);
      const r = await this.runShell(`if(Test-Path -LiteralPath ${q}){ '__yes__' } else { '__no__' }`);
      return r.stdout.trim() === "__yes__";
    }
    const quoted = singleQuote(filePath);
    const r = await this.runShell(`test -e ${quoted} && echo __yes__ || echo __no__`);
    return r.stdout.trim() === "__yes__";
  }
}

// ──────────────────────── helpers ────────────────────────

/** POSIX single-quote: wrap value in '...' and escape embedded quotes. */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quote: wrap in '...' with embedded ' doubled. */
function pwshQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Encode a PowerShell script as `powershell -EncodedCommand <base64-utf16le>`.
 * Avoids every layer of shell escaping when sending PowerShell through ssh
 * to a Windows target whose default shell is cmd.exe.
 */
function encodePwshOverSsh(script: string): string {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${b64}`;
}

// ──────────────────────── AzureRunCommandContext ───────────────────
//
// Executes shell/PowerShell against an Azure VM without requiring any inbound
// port (no SSH, no WinRM, no public IP). Uses `az vm run-command invoke` over
// the ARM REST API, authenticated via the local `az login` session.
//
// Trade-offs:
//   • High latency: each invocation provisions/uses the RunCommand extension,
//     typically 8–30 s. Probes that pass short timeouts are floored to the
//     context's defaultTimeoutMs.
//   • Exit code is not propagated by RunCommand directly. We sniff a marker
//     `__TWC_EXIT__:<n>` we append to every script.
//   • Requires `az` on PATH and an active `az login` (no token mgmt here).

export interface AzureVmOptions {
  /** Azure resource group containing the VM. */
  resourceGroup: string;
  /** VM name (not the hostname). */
  vmName: string;
  /** Optional Azure subscription id; otherwise the az CLI default is used. */
  subscription?: string;
  /** Per-command timeout in ms. Default 120000 (RunCommand is slow). */
  defaultTimeoutMs?: number;
}

export class AzureRunCommandContext implements ExecutionContext {
  readonly kind = "azure-vm" as const;
  os: RemoteOs;
  readonly description: string;
  private readonly opts: AzureVmOptions;

  private constructor(opts: AzureVmOptions, os: RemoteOs) {
    this.opts = opts;
    this.os = os;
    this.description =
      `azure-vm ${opts.resourceGroup}/${opts.vmName}` +
      (opts.subscription ? ` (sub=${opts.subscription})` : "");
  }

  /**
   * Verify the az CLI is installed + logged in, then detect the VM OS via
   * `az vm show` (cheap, no RunCommand). Throws with an actionable message
   * on any failure so the worker surfaces it as a clean job error.
   */
  static async connect(opts: AzureVmOptions): Promise<AzureRunCommandContext> {
    // 1. az present?
    try {
      await pExecFile("az", ["--version"], { timeout: 8000, maxBuffer: 1 << 20 });
    } catch {
      throw new Error(
        "azure-vm target requires the 'az' CLI on PATH. Install Azure CLI and run 'az login' first."
      );
    }

    // 2. Resolve OS from the VM record.
    const args = [
      "vm", "show",
      "-g", opts.resourceGroup,
      "-n", opts.vmName,
      "--query", "storageProfile.osDisk.osType",
      "-o", "tsv"
    ];
    if (opts.subscription) args.push("--subscription", opts.subscription);
    let osType = "";
    try {
      const r = await pExecFile("az", args, { timeout: 30000, maxBuffer: 1 << 20 });
      osType = r.stdout.trim().toLowerCase();
    } catch (err) {
      throw new Error(
        `azure-vm target: 'az vm show -g ${opts.resourceGroup} -n ${opts.vmName}' failed. ` +
          `Check the resource group, VM name, and that 'az login' grants access. ` +
          `(${err instanceof Error ? err.message : String(err)})`
      );
    }
    const os: RemoteOs = osType === "linux" ? "linux" : osType === "windows" ? "windows" : "unknown";
    return new AzureRunCommandContext(opts, os);
  }

  async runShell(command: string, opts: ShellOptions = {}): Promise<ShellResult> {
    const t0 = Date.now();
    // RunCommand has high baseline latency; treat probe-supplied timeouts as
    // a lower bound rather than a hard cap.
    const timeout = Math.max(opts.timeoutMs ?? 8000, this.opts.defaultTimeoutMs ?? 120000);
    const maxBuffer = opts.maxBuffer ?? 4 * 1024 * 1024;

    // Append an exit-code marker we can sniff out of the RunCommand stdout.
    const wrapped =
      this.os === "windows"
        ? `${command}\n"__TWC_EXIT__:$LASTEXITCODE"`
        : `${command}\necho "__TWC_EXIT__:$?"`;
    const commandId = this.os === "windows" ? "RunPowerShellScript" : "RunShellScript";

    const args = [
      "vm", "run-command", "invoke",
      "-g", this.opts.resourceGroup,
      "-n", this.opts.vmName,
      "--command-id", commandId,
      "--scripts", wrapped,
      "-o", "json"
    ];
    if (this.opts.subscription) args.push("--subscription", this.opts.subscription);

    try {
      const r = await pExecFile("az", args, { timeout, maxBuffer });
      return { ...parseAzureRunCommandOutput(r.stdout), ms: Date.now() - t0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
      // az often emits a non-zero exit when the VM script itself failed but
      // still returns a valid JSON envelope on stdout — try to parse it.
      if (e.stdout && e.stdout.includes("value")) {
        try {
          return { ...parseAzureRunCommandOutput(e.stdout), ms: Date.now() - t0 };
        } catch {
          /* fall through */
        }
      }
      return {
        stdout: String(e.stdout ?? "").trim(),
        stderr: String(e.stderr ?? e.message ?? "").trim(),
        exitCode: typeof e.code === "number" ? e.code : null,
        ms: Date.now() - t0
      };
    }
  }

  async readFile(filePath: string, maxBytes = 256 * 1024): Promise<string> {
    if (this.os === "windows") {
      const q = pwshQuote(filePath);
      const script =
        `$ErrorActionPreference='SilentlyContinue';` +
        `if(-not (Test-Path -LiteralPath ${q})){ return };` +
        `$fi=Get-Item -LiteralPath ${q};` +
        `$max=${maxBytes};` +
        `$fs=[IO.File]::OpenRead($fi.FullName);` +
        `try{` +
        `  if($fi.Length -gt $max){ [void]$fs.Seek($fi.Length - $max,'Begin') };` +
        `  $len=[Math]::Min([int64]$fi.Length,[int64]$max);` +
        `  $buf=New-Object byte[] $len;` +
        `  [void]$fs.Read($buf,0,$len);` +
        `  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($buf))` +
        `}finally{ $fs.Dispose() }`;
      const r = await this.runShell(script);
      return r.exitCode === 0 ? r.stdout : "";
    }
    const quoted = singleQuote(filePath);
    const r = await this.runShell(`tail -c ${maxBytes} ${quoted} 2>/dev/null || true`);
    return r.exitCode === 0 ? r.stdout : "";
  }

  async listDir(dirPath: string): Promise<DirEntry[]> {
    if (this.os === "windows") {
      const q = pwshQuote(dirPath);
      const script =
        `if(-not (Test-Path -LiteralPath ${q})){ return };` +
        `Get-ChildItem -LiteralPath ${q} -Force -ErrorAction SilentlyContinue | ForEach-Object {` +
        `  $isFile = -not $_.PSIsContainer;` +
        `  $size = if($isFile){ [int64]$_.Length } else { -1 };` +
        `  '{0}\t{1}\t{2}\t{3}' -f ($(if($isFile){'F'}else{'D'})), $size, $_.Name, $_.FullName` +
        `}`;
      const r = await this.runShell(script);
      return parseTabbedDirListing(r.stdout);
    }
    const quoted = singleQuote(dirPath);
    const r = await this.runShell(
      `ls -L1A ${quoted} 2>/dev/null | while IFS= read -r f; do printf "%s\\t%s\\n" "$(stat -c%s "${quoted}/$f" 2>/dev/null || stat -f%z "${quoted}/$f" 2>/dev/null || echo -1)" "$f"; done`
    );
    return parsePosixDirListing(r.stdout, dirPath);
  }

  async pathExists(filePath: string): Promise<boolean> {
    if (this.os === "windows") {
      const q = pwshQuote(filePath);
      const r = await this.runShell(`if(Test-Path -LiteralPath ${q}){ '__yes__' } else { '__no__' }`);
      return r.stdout.includes("__yes__");
    }
    const quoted = singleQuote(filePath);
    const r = await this.runShell(`test -e ${quoted} && echo __yes__ || echo __no__`);
    return r.stdout.includes("__yes__");
  }
}

/**
 * Extract stdout / stderr / exit code from the JSON envelope returned by
 * `az vm run-command invoke ... -o json`. Format:
 *   { "value": [ { "message": "Enable succeeded:\n[stdout]\n<out>\n\n[stderr]\n<err>\n" } ] }
 */
function parseAzureRunCommandOutput(raw: string): Omit<ShellResult, "ms"> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  try {
    const j = JSON.parse(raw) as { value?: Array<{ message?: string }> };
    const msg = j.value?.[0]?.message ?? "";
    const stdMatch = msg.match(/\[stdout\]\n([\s\S]*?)\n\[stderr\]/);
    const errMatch = msg.match(/\[stderr\]\n([\s\S]*)$/);
    stdout = stdMatch?.[1] ?? "";
    stderr = (errMatch?.[1] ?? "").trim();
    // Strip + extract our injected exit-code marker.
    const markerRe = /__TWC_EXIT__:(-?\d+)/;
    const m = stdout.match(markerRe);
    if (m) {
      const parsed = parseInt(m[1], 10);
      exitCode = Number.isFinite(parsed) ? parsed : 0;
      stdout = stdout.replace(markerRe, "").trimEnd();
    }
  } catch {
    stdout = raw;
  }
  return { stdout, stderr, exitCode };
}

/** Parse the tab-separated `F\tSIZE\tNAME\tFULLPATH` listing emitted by our Windows scripts. */
function parseTabbedDirListing(text: string): DirEntry[] {
  if (!text) return [];
  const out: DirEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const [kind, sizeStr, name, full] = parts;
    const size = parseInt(sizeStr, 10);
    const nm = (name ?? "").trim();
    if (!nm) continue;
    out.push({ name: nm, path: (full ?? "").trim(), size: isNaN(size) ? -1 : size, isFile: kind === "F" });
  }
  return out;
}

/** Parse the SIZE<TAB>NAME listing emitted by our POSIX ls/stat one-liner. */
function parsePosixDirListing(text: string, dirPath: string): DirEntry[] {
  if (!text) return [];
  const out: DirEntry[] = [];
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const size = parseInt(line.slice(0, tab), 10);
    const name = line.slice(tab + 1).trim();
    if (!name) continue;
    out.push({
      name,
      path: `${dirPath.replace(/\/+$/, "")}/${name}`,
      size: isNaN(size) ? -1 : size,
      isFile: !isNaN(size) && size >= 0
    });
  }
  return out;
}

// ──────────────────────── KubectlExecContext ─────────────────────
//
// Executes shell commands inside a Kubernetes pod via `kubectl exec`. Uses
// the kubeconfig already on the runner (KUBECONFIG / ~/.kube/config) — we
// don't reimplement auth here.
//
// Limitations:
//   • Windows pods are out of scope. We always treat the target as Linux.
//   • The pod must have /bin/sh available (true for almost every base image).
//   • No persistent shell session: each runShell spawns a fresh exec, so
//     `cd` / env exports do not carry across calls (same constraint as SSH).

export interface KubectlOptions {
  /** Pod namespace (required). */
  namespace: string;
  /** Pod name (required). */
  pod: string;
  /** Optional container name when the pod has multiple containers. */
  container?: string;
  /** Optional kubeconfig context. */
  kubeContext?: string;
  /** Per-command timeout in ms. Default 15000. */
  defaultTimeoutMs?: number;
}

export class KubectlExecContext implements ExecutionContext {
  readonly kind = "k8s" as const;
  readonly os: RemoteOs = "linux";
  readonly description: string;
  private readonly opts: KubectlOptions;

  private constructor(opts: KubectlOptions) {
    this.opts = opts;
    this.description =
      `k8s ${opts.namespace}/${opts.pod}` +
      (opts.container ? `:${opts.container}` : "") +
      (opts.kubeContext ? ` (ctx=${opts.kubeContext})` : "");
  }

  /** Verify kubectl is installed and the pod is reachable. */
  static async connect(opts: KubectlOptions): Promise<KubectlExecContext> {
    try {
      await pExecFile("kubectl", ["version", "--client=true", "-o", "json"], {
        timeout: 8000,
        maxBuffer: 1 << 20
      });
    } catch {
      throw new Error("k8s target requires the 'kubectl' CLI on PATH. Install kubectl first.");
    }
    const ctx = new KubectlExecContext(opts);
    // One-shot reachability probe; if it fails the worker can surface a clean error.
    const probe = await ctx.runShell("uname -s", { timeoutMs: 8000 });
    if (probe.exitCode !== 0) {
      throw new Error(
        `k8s target: cannot exec into ${opts.namespace}/${opts.pod}` +
          (opts.container ? `:${opts.container}` : "") +
          ` (${probe.stderr || "unknown error"}).`
      );
    }
    return ctx;
  }

  private kubectlBaseArgs(): string[] {
    const args = ["exec", "-n", this.opts.namespace, this.opts.pod];
    if (this.opts.container) args.push("-c", this.opts.container);
    if (this.opts.kubeContext) args.unshift("--context", this.opts.kubeContext);
    return args;
  }

  async runShell(command: string, opts: ShellOptions = {}): Promise<ShellResult> {
    const t0 = Date.now();
    const timeout = opts.timeoutMs ?? this.opts.defaultTimeoutMs ?? 15000;
    const maxBuffer = opts.maxBuffer ?? 2 * 1024 * 1024;
    const args = [...this.kubectlBaseArgs(), "--", "/bin/sh", "-c", command];
    try {
      const r = await pExecFile("kubectl", args, { timeout, maxBuffer });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: 0, ms: Date.now() - t0 };
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        stdout: String(e.stdout ?? "").trim(),
        stderr: String(e.stderr ?? e.message ?? "").trim(),
        exitCode: typeof e.code === "number" ? e.code : null,
        ms: Date.now() - t0
      };
    }
  }

  async readFile(filePath: string, maxBytes = 256 * 1024): Promise<string> {
    const quoted = singleQuote(filePath);
    const r = await this.runShell(`tail -c ${maxBytes} ${quoted} 2>/dev/null || true`);
    return r.exitCode === 0 ? r.stdout : "";
  }

  async listDir(dirPath: string): Promise<DirEntry[]> {
    const quoted = singleQuote(dirPath);
    const r = await this.runShell(
      `ls -L1A ${quoted} 2>/dev/null | while IFS= read -r f; do printf "%s\\t%s\\n" "$(stat -c%s "${quoted}/$f" 2>/dev/null || stat -f%z "${quoted}/$f" 2>/dev/null || echo -1)" "$f"; done`
    );
    return parsePosixDirListing(r.stdout, dirPath);
  }

  async pathExists(filePath: string): Promise<boolean> {
    const quoted = singleQuote(filePath);
    const r = await this.runShell(`test -e ${quoted} && echo __yes__ || echo __no__`);
    return r.stdout.includes("__yes__");
  }
}

// ───────────────────────── factory ─────────────────────────

export interface CreateContextOptions {
  /** Target as the user typed it (IP, hostname or "local-device"). */
  target: string;
  /** Required for any non-local target. */
  user?: string;
  /** Optional SSH port (default 22). */
  port?: number;
  /** Optional explicit identity file. */
  identity?: string;
}

/**
 * Decide whether the target is local, SSH-remote, an Azure VM or a Kubernetes
 * pod, and build the right context.
 *
 * Heuristic — a target is "local" when:
 *   • it's literally "local-device" / "localhost" / "127.0.0.1" / "::1", OR
 *   • no `--user` was provided AND the target looks like a name with no
 *     network meaning (no dots, not an IP, not "user@host").
 *
 * URL-style targets force the matching backend regardless of --user:
 *   • ssh://[user@]host[:port]                       → SshContext
 *   • azure-vm://<resource-group>/<vm-name>          → AzureRunCommandContext
 *   • k8s://<namespace>/<pod>[?container=<c>]        → KubectlExecContext
 *
 * For bare SSH targets (no scheme) `user` is mandatory when the target looks
 * remote — we never silently fall back to $USER / $USERNAME because that
 * would change diagnostic behaviour invisibly between machines.
 */
export async function createExecutionContext(opts: CreateContextOptions): Promise<ExecutionContext> {
  const target = opts.target.trim();
  const lower = target.toLowerCase();

  // Explicit local markers always win.
  if (lower === "local-device" || lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "") {
    return new LocalContext();
  }

  // URL-style: azure-vm://<rg>/<vm>
  if (lower.startsWith("azure-vm://")) {
    const rest = target.slice("azure-vm://".length);
    const [rg, vm] = rest.split("/").map((s) => s.trim());
    if (!rg || !vm) {
      throw new Error(`Invalid azure-vm target '${target}'. Expected azure-vm://<resource-group>/<vm-name>.`);
    }
    return AzureRunCommandContext.connect({
      resourceGroup: rg,
      vmName: vm,
      // Reuse --identity (rare for Azure) as a passthrough for subscription id
      // would be confusing — keep subscription unset; users can rely on
      // `az account set --subscription <id>` before launching twc.
      defaultTimeoutMs: 120_000
    });
  }

  // URL-style: k8s://<namespace>/<pod>[?container=X]
  if (lower.startsWith("k8s://") || lower.startsWith("kubernetes://")) {
    const prefix = lower.startsWith("kubernetes://") ? "kubernetes://" : "k8s://";
    const rest = target.slice(prefix.length);
    const [pathPart, query] = rest.split("?");
    const [ns, pod] = pathPart.split("/").map((s) => s.trim());
    if (!ns || !pod) {
      throw new Error(`Invalid k8s target '${target}'. Expected k8s://<namespace>/<pod>[?container=<c>].`);
    }
    let container: string | undefined;
    if (query) {
      const params = new URLSearchParams(query);
      container = params.get("container") ?? undefined;
    }
    return KubectlExecContext.connect({ namespace: ns, pod, container, defaultTimeoutMs: 15_000 });
  }

  // URL-style: ssh://[user@]host[:port]
  if (lower.startsWith("ssh://")) {
    const url = new URL(target);
    const host = url.hostname;
    if (!host) throw new Error(`Invalid ssh target '${target}'. Expected ssh://[user@]host[:port].`);
    const user = url.username || opts.user;
    const port = url.port ? Number(url.port) : opts.port;
    if (!user) {
      throw new Error(
        `ssh target '${target}' is missing a username. Use ssh://<user>@${host} or pass --user.`
      );
    }
    return SshContext.connect({ host, user, port, identity: opts.identity });
  }

  // user@host shorthand → treat as SSH even when --user is missing.
  let host = target;
  let user = opts.user;
  const at = target.indexOf("@");
  if (at > 0 && at < target.length - 1) {
    user = user ?? target.slice(0, at);
    host = target.slice(at + 1);
  }

  // A plain symbolic name with no dots and no --user is most likely a
  // logical label ("vm-twc-demo", "tenant-acme") referenced in the LLM
  // prompt — keep it local so the probes don't try to SSH into thin air.
  const looksLikeNetworkTarget =
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.includes(".");
  if (!user && !looksLikeNetworkTarget) {
    return new LocalContext();
  }

  if (!user) {
    throw new Error(
      `Target '${target}' looks remote but no --user was provided. ` +
        `Pass --user <ssh-user> (and optionally --port / --key), or use --target local-device for an on-host run.`
    );
  }

  return SshContext.connect({ host, user, port: opts.port, identity: opts.identity });
}
