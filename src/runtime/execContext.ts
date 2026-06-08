// ExecutionContext — uniform shell-execution abstraction so the probes can
// run identically on the local machine OR on a remote SSH host.
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
// LocalContext  uses Node's child_process / fs.
// SshContext    spawns `ssh -n -o BatchMode=yes …` for every command — reusing
//               the hardened `buildSshArgs` already used by `inspect-remote`
//               (including the critical `-n` flag that prevents Windows OpenSSH
//               from hanging on inherited stdin).
//
// New probes should ONLY use ctx.runShell / ctx.readFile — never `execFile`
// or `fs.*` directly — otherwise they break for remote targets.

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
  /** "local" when running on the machine that hosts the CLI, "ssh" otherwise. */
  readonly kind: "local" | "ssh";
  /** OS of the *target* (not the runner). Detected lazily for SSH contexts. */
  readonly os: RemoteOs;
  /** Human label used in reports: "local" or "ssh user@host". */
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
   * Create an SshContext and detect the remote OS up-front (`uname -s`).
   * Falls back to "unknown" if the detection fails — probes can still try
   * generic POSIX commands.
   */
  static async connect(opts: SshConnectionOptions): Promise<SshContext> {
    // Probe reachability + OS detection in one round-trip. We deliberately
    // avoid Windows-target detection for now (Windows SSH typically responds
    // with a CMD prompt that doesn't parse `uname` cleanly — out of scope
    // for the current phase).
    const probe = await SshContext.execOnce(opts, "uname -s 2>/dev/null || echo __unknown__", 6000);
    const out = probe.stdout.trim().toLowerCase();
    let os: RemoteOs = "unknown";
    if (out.includes("darwin")) os = "macos";
    else if (out.includes("linux")) os = "linux";
    else if (out.includes("mingw") || out.includes("msys") || out.includes("cygwin")) os = "linux";
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
    try {
      const r = await pExecFile("ssh", buildSshArgs(this.opts, command), { timeout, maxBuffer });
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
    // Use `tail -c` to bounded-read remote files. `head -c N | tail` would
    // work too but `tail -c N` already does the right thing.
    const quoted = singleQuote(filePath);
    const r = await this.runShell(`tail -c ${maxBytes} ${quoted} 2>/dev/null || true`);
    return r.exitCode === 0 ? r.stdout : "";
  }

  async listDir(dirPath: string): Promise<DirEntry[]> {
    const quoted = singleQuote(dirPath);
    // Tab-separated: <size>\t<name>; -L follows symlinks for size accuracy.
    const r = await this.runShell(
      `ls -L1A --file-type=never ${quoted} 2>/dev/null | while IFS= read -r f; do printf "%s\\t%s\\n" "$(stat -c%s "${quoted}/$f" 2>/dev/null || stat -f%z "${quoted}/$f" 2>/dev/null || echo -1)" "$f"; done`
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
    const quoted = singleQuote(filePath);
    const r = await this.runShell(`test -e ${quoted} && echo __yes__ || echo __no__`);
    return r.stdout.trim() === "__yes__";
  }
}

// ───────────────────────── helpers ─────────────────────────

/** POSIX single-quote: wrap value in '...' and escape embedded quotes. */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
 * Decide whether the target is local or remote and build the right context.
 *
 * Heuristic — a target is "local" when:
 *   • it's literally "local-device" / "localhost" / "127.0.0.1" / "::1", OR
 *   • no `--user` was provided AND the target looks like a name with no
 *     network meaning (no dots, not an IP, not "user@host").
 *
 * In every other case the target is treated as a remote SSH host and `user`
 * is mandatory (we never silently fall back to $USER / $USERNAME because
 * that would change diagnostic behaviour invisibly between machines).
 */
export async function createExecutionContext(opts: CreateContextOptions): Promise<ExecutionContext> {
  const target = opts.target.trim();
  const lower = target.toLowerCase();

  // Explicit local markers always win.
  if (lower === "local-device" || lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "") {
    return new LocalContext();
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
