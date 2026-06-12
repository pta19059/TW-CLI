// Real TeamViewer log harvester + signature clustering.
//
// Walks the per-product log directories on the target (local or SSH-remote),
// reads up to MAX_BYTES_PER_FILE of each known log file, and groups
// error/warning lines by a normalized signature (timestamps and numeric IDs
// stripped) so recurring failures collapse into one cluster.
//
// Execution is fully ctx-driven so the same code path works for:
//   • LocalContext  → uses fs directly via the context's readFile / listDir
//   • SshContext    → uses tail -c, ls -1A, test -e over SSH
// The probe is async because remote ops can't be sync.

import path from "node:path";
import { getProductProfile, productLogDirs, type ProductDiagnosticProfile } from "../catalog/productProfiles.js";
import { LocalContext, type ExecutionContext, type RemoteOs } from "../runtime/execContext.js";

const MAX_BYTES_PER_FILE = 256 * 1024; // 256 KB tail per file
const MAX_FILES = 8;
const TOP_SIGNATURES = 5;

export interface SignatureCluster {
  signature: string;
  count: number;
  exampleLine: string;
  /**
   * Diagnostic-relevance weight applied to `count` when ranking. benign≈0.15,
   * generic=1, fault categories 2–3. Optional so external/test constructors
   * can omit it — `fromLogs` recomputes it via classifySignature when absent.
   */
  weight?: number;
  /** Fault classification: benign | dns | network | transport | tls | auth | crash | generic. */
  category?: SignatureCategory;
}

export type SignatureCategory =
  | "benign"
  | "dns"
  | "network"
  | "transport"
  | "tls"
  | "auth"
  | "crash"
  | "generic";

/**
 * Classify a log signature by how diagnostically RELEVANT it is to a
 * connectivity / disconnect problem.
 *
 * WHY THIS EXISTS (the definitive fix for "wrong root cause"):
 * Frequency alone is a misleading ranking signal. TeamViewer (and most apps)
 * emit high-volume *cosmetic* lines on a perfectly HEALTHY client — device
 * enumeration buffer probes ("DriverInstalled: SetupDiGetDeviceRegistryProperty
 * failed with error code 122"), management-poll noise ("device that is not
 * managed"), etc. Ranking purely by occurrence count lets that benign noise
 * outrank — and mask — the genuine network-fault signatures, producing a
 * confident-but-wrong root cause. We multiply each signature's count by a
 * relevance weight so a benign line can never become "dominant", while a real
 * fault signature is promoted even at a lower count.
 *
 * Returns the multiplicative weight + a coarse category used for action routing.
 */
export function classifySignature(text: string): { weight: number; category: SignatureCategory } {
  const s = text.toLowerCase();

  // 1. Known-benign / cosmetic patterns. These recur constantly on a HEALTHY
  //    client and never explain a drop. Pinned low so volume cannot promote
  //    them. Checked FIRST so the "!!" severity boost below never applies to
  //    them (TeamViewer tags even cosmetic lines "G2!!").
  if (
    /driverinstalled|setupdigetdeviceregistryproperty|error ?code ?122|errorcode=122/.test(s) ||
    /updatedeviceflags|device that is not managed|\bnot managed\b|no assignment|managementinfo/.test(s) ||
    /module loaded|carrier loaded|registered for|heartbeat ok|keep ?alive (?:ok|sent|ack)/.test(s)
  ) {
    return { weight: 0.15, category: "benign" };
  }

  // 2. Genuine fault categories. Highest-signal wins; weights tuned so any
  //    real fault (>=2.0) decisively outranks generic noise (1.0) and benign
  //    (0.15) regardless of plausible count differences.
  const FAULTS: { name: SignatureCategory; w: number; re: RegExp }[] = [
    { name: "dns", w: 3.0, re: /could not resolve|resolve failed|getaddrinfo|name (?:not|or service not) known|nodename nor servname|asio\.netdb|dns/ },
    { name: "crash", w: 2.8, re: /access violation|segfault|segmentation fault|unhandled exception|\bfatal\b|stack ?trace|0xc0000005|core dumped/ },
    { name: "tls", w: 2.6, re: /handshake|\btls\b|\bssl\b|certificate|x509|cert verify|self.signed|untrusted/ },
    { name: "network", w: 2.5, re: /securenetwork|connection not found|\brcommand\b|resend to|dyngate|sendtodyngate|retrystrategy|sendcallback|invalid sender/ },
    { name: "auth", w: 2.4, re: /unauthor|forbidden|\b401\b|\b403\b|\btoken\b|credential|access denied|login failed/ },
    { name: "transport", w: 2.2, re: /timed? ?out|timeout|connection reset|broken pipe|aborted|disconnect|retryhandle|::handleretry|retransmit|netwatchdog|connection lost/ },
  ];
  let weight = 1.0;
  let category: SignatureCategory = "generic";
  for (const f of FAULTS) {
    if (f.re.test(s) && f.w > weight) {
      weight = f.w;
      category = f.name;
    }
  }

  // 3. TeamViewer severity-marker boost: lines the client itself flags "!!"
  //    are serious errors; nudge them slightly above equal-count peers.
  if (/!!/.test(text)) weight *= 1.15;

  return { weight, category };
}

/**
 * Rank clustered signatures by RELEVANCE (count × severity weight), not raw
 * frequency, and keep the top N. This is the single ranking authority shared by
 * every scan path so a benign high-frequency line can never surface as the
 * dominant signature anywhere in the pipeline.
 */
function rankSignatures(
  counts: Map<string, { count: number; example: string }>
): SignatureCluster[] {
  return [...counts.entries()]
    .map(([signature, { count, example }]) => {
      const { weight, category } = classifySignature(`${signature} ${example}`);
      return { signature, count, exampleLine: example, weight, category };
    })
    .sort((a, b) => b.count * b.weight - a.count * a.weight)
    .slice(0, TOP_SIGNATURES);
}

/**
 * macOS power-management findings. Correlates TeamViewer NetWatchdog standby
 * events with `pmset` settings so an "it drops every few minutes" symptom that
 * is really *idle-sleep dropping the connection* can be diagnosed correctly
 * instead of being misattributed to the post-wake RetryHandle error burst.
 */
export interface PowerEventSummary {
  /** Which OS produced this summary — drives OS-specific report wording. */
  os?: RemoteOs;
  /**
   * The real drops. macOS: "Completely disconnected. Going offline" NetWatchdog
   * events. Windows: Kernel-Power sleep-enter events (Id 42 / 506). Linux:
   * systemd-logind "PrepareForSleep" suspend transitions.
   */
  standbyDisconnects: number;
  /** Sleep/standby transitions (macOS "OnStandby going to sleep"; same as standbyDisconnects on Win/Linux). */
  standbyEnters: number;
  /** Wake/resume recoveries (macOS "OnStandby woke up"; Windows Id 107/507/1; Linux resume). */
  wakeRecoveries: number;
  /** Best-effort timestamps of the disconnect/sleep events, oldest→newest. */
  disconnectTimes: string[];
  /** pmset `sleep == 0` / Windows AC standby-timeout == 0 (true = sleep disabled). */
  sleepDisabled?: boolean;
  /** pmset `standby == 1` / Windows AC standby-timeout > 0. */
  standbyEnabled?: boolean;
  /** pmset `powernap == 1` (macOS only). */
  powerNapEnabled?: boolean;
  /** pmset `tcpkeepalive == 1` (macOS only). */
  tcpKeepAlive?: boolean;
  /** pmset `standbydelaylow` / Windows AC standby idle timeout (seconds). */
  standbyDelayLowSec?: number;
  /** Compact human-readable pmset summary for the Evidence block (macOS). */
  pmsetSummary?: string;
  /** Compact human-readable powercfg summary for the Evidence block (Windows). */
  powercfgSummary?: string;
}

export interface LogProbeReport {
  filesInspected: string[];
  totalLines: number;
  errorCount: number;
  warningCount: number;
  topSignatures: SignatureCluster[];
  diagnostics: string[];
  /** Product the probe targeted (display name). */
  product?: string;
  /** Description of where the probe ran ("local" or "ssh user@host"). */
  executionTarget?: string;
  /** macOS power-management correlation (undefined on non-macOS targets). */
  power?: PowerEventSummary;
}


/**
 * Candidate log directories on a *remote* host, by target OS. Local runs
 * still go through productLogDirs() which expands per-user/per-machine
 * env vars (APPDATA, PROGRAMDATA, …).
 *
 * Remote paths intentionally use literal /Library/... / /var/log/... rather
 * than $HOME expansion in the directory list — $HOME is expanded by the
 * remote shell on each `ctx.runShell` call, so callers can compose paths
 * like `$HOME/Library/Logs/TeamViewer` inside their commands.
 */
function remoteLogRoots(os: RemoteOs): string[] {
  if (os === "macos") {
    return [
      "$HOME/Library/Logs/TeamViewer",
      "/Library/Logs/TeamViewer",
      // Some TeamViewer 15 installs write under Application Support too.
      "$HOME/Library/Application Support/TeamViewer/Logs",
      "/Library/Application Support/TeamViewer/Logs",
      // Sandboxed container path (mas / app-store style installs).
      "$HOME/Library/Containers/com.teamviewer.TeamViewer/Data/Library/Logs/TeamViewer",
      "$HOME/Library/Containers/com.teamviewer.TeamViewer/Data/Library/Logs"
    ];
  }
  if (os === "linux") {
    return [
      "/var/log/teamviewer",
      "$HOME/.local/share/teamviewer",
      "/opt/1E/Client"
    ];
  }
  if (os === "windows") {
    // TeamViewer 15 writes its connection/network logs into the INSTALL dir
    // (C:\Program Files\TeamViewer\TeamViewer15_Logfile.log, TVNetwork.log,
    // TeamViewer15_Hooks.log) — NOT under %APPDATA% on most desktop installs.
    // ProgramData covers ServiceMode/DEX; %APPDATA%/%LOCALAPPDATA% cover
    // per-user installs. Install dir is listed FIRST because it holds the
    // real session logs. PowerShell-friendly expansion via ExpandString.
    return [
      "$env:ProgramFiles\\TeamViewer",
      "${env:ProgramFiles(x86)}\\TeamViewer",
      "$env:APPDATA\\TeamViewer",
      "$env:LOCALAPPDATA\\TeamViewer",
      "$env:ProgramData\\TeamViewer\\Logs",
      "$env:ProgramData\\TeamViewer",
      "$env:ProgramData\\1E\\Client"
    ];
  }
  return [];
}

interface FoundFile {
  /** Absolute path on the target. */
  path: string;
  /** Best-effort size in bytes (-1 = unknown). */
  size: number;
}

async function findLogFilesLocal(profile: ProductDiagnosticProfile, ctx: ExecutionContext): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  for (const dir of productLogDirs(profile.key, process.platform)) {
    if (!(await ctx.pathExists(dir))) continue;
    const entries = await ctx.listDir(dir);
    for (const e of entries) {
      if (!e.isFile) continue;
      if (!profile.logFilePattern.test(e.name)) continue;
      out.push({ path: e.path, size: e.size });
      if (out.length >= MAX_FILES) return out;
    }
  }
  return out;
}

async function findLogFilesRemote(profile: ProductDiagnosticProfile, ctx: ExecutionContext): Promise<FoundFile[]> {
  // Build one POSIX or PowerShell command that walks every candidate dir and
  // emits "size<TAB>path" for files whose name matches the product pattern.
  // We extract the pattern's source so the shell-side filter can use it
  // (good enough — false positives are harmless, will be re-filtered below).
  const patternSrc = profile.logFilePattern.source;
  const roots = remoteLogRoots(ctx.os);
  if (roots.length === 0) return [];

  if (ctx.os === "windows") {
    // PowerShell variant — `Get-ChildItem -Path … -File -Recurse:$false -Filter *`
    // and filter by regex client-side via Where-Object.
    // Emit "size<TAB>path" using [char]9 for the tab: a backtick-t escape only
    // produces a tab inside DOUBLE-quoted PowerShell strings, so the original
    // single-quoted `'{0}\`t{1}'` form emitted a LITERAL backtick-t and broke
    // parseSizePathPairs (which splits on a real tab) → zero files discovered.
    const escaped = patternSrc.replace(/'/g, "''");
    const dirsExpr = roots.map((r) => `'${r.replace(/'/g, "''")}'`).join(",");
    const cmd =
      `$pat='${escaped}'; $tab=[char]9; ` +
      `foreach($d in @(${dirsExpr})){ ` +
      `  $resolved = $ExecutionContext.InvokeCommand.ExpandString($d); ` +
      `  if(Test-Path $resolved){ Get-ChildItem -LiteralPath $resolved -File -ErrorAction SilentlyContinue | ` +
      `    Where-Object { $_.Name -match $pat } | ForEach-Object { '{0}{1}{2}' -f $_.Length, $tab, $_.FullName } } ` +
      `}`;
    const r = await ctx.runShell(cmd, { timeoutMs: 15000 });
    return parseSizePathPairs(r.stdout).slice(0, MAX_FILES);
  }

  // POSIX (linux + macos): expand $HOME-style paths and stat each match.
  // The remote regex filter uses `awk` since `find` doesn't natively grok JS-style regex.
  const dirsExpr = roots.map((r) => `"${r.replace(/"/g, '\\"')}"`).join(" ");
  // Convert the JS regex (which often uses \. and (?:...)) into something ERE-compatible
  // enough for `awk`. We keep it simple: escape sequences pass through.
  // CRITICAL: profile.logFilePattern carries the /i flag, but `.source` strips
  // it. macOS files are named "TeamViewer15_Logfile.log" (capital T) so a
  // bare `name ~ pat` against `teamviewer.*\.log$` would NOT match. We
  // lowercase BOTH the candidate filename AND the pattern in awk so the
  // match is effectively case-insensitive (POSIX awk has no //i flag).
  const awkPat = patternSrc.toLowerCase().replace(/'/g, "'\\''");
  const cmd =
    `for d in ${dirsExpr}; do ` +
    `  if [ -d "$d" ]; then ` +
    `    /usr/bin/find "$d" -maxdepth 1 -type f 2>/dev/null | ` +
    `    awk -v pat='${awkPat}' 'match($0, "[^/]+$"){ name=tolower(substr($0,RSTART,RLENGTH)); if (name ~ pat) print $0 }' | ` +
    `    while IFS= read -r f; do ` +
    `      sz=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo -1); ` +
    `      printf "%s\\t%s\\n" "$sz" "$f"; ` +
    `    done; ` +
    `  fi; ` +
    `done`;
  const r = await ctx.runShell(cmd, { timeoutMs: 10000 });
  return parseSizePathPairs(r.stdout).slice(0, MAX_FILES);
}

function parseSizePathPairs(text: string): FoundFile[] {
  const out: FoundFile[] = [];
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const size = parseInt(line.slice(0, tab), 10);
    const p = line.slice(tab + 1);
    if (!p) continue;
    out.push({ path: p, size: isNaN(size) ? -1 : size });
  }
  return out;
}

// Normalize a log line into a "signature" by stripping timestamps, hex/numeric
// ids and quoted strings. Two lines with the same signature describe the same
// failure class even if their timestamps and instance ids differ.
//
// Special-cases the macOS unified-log compact format
//   "YYYY-MM-DD HH:MM:SS.fff  L   Process[pid:tid] [subsystem:category] payload"
// because (a) the time regex below would otherwise eat "99:158b" from the
// "[pid:tid]" thread-id and leave gibberish, and (b) the [pid:tid] +
// [subsystem:category] boilerplate splits identical payloads across multiple
// thread-id variants (so 102 "Could not resolve" lines look like 4 clusters
// of 32/27/24/19 instead of one cluster of 102).
export function normalize(line: string): string {
  return line
    // Strip macOS unified-log compact prefix wholesale, including the
    // optional [subsystem:category] tag that some lines carry. Process name
    // allows dots/dashes (e.g. TeamViewer-Helper, com.teamviewer.Service).
    .replace(
      /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+[A-Za-z]{1,3}\s+[A-Za-z_][\w.\-]*\[\d+:[0-9a-f]+\]\s+(?:\[[^\]]+\]\s+)?/,
      ""
    )
    // Defensive: any "Process[pid:hex_tid]" tag that still leaks through.
    .replace(/\b[A-Za-z_][\w.\-]*\[\d+:[0-9a-f]+\]\s+/g, "")
    .replace(/\d{2,4}[-\/]\d{1,2}[-\/]\d{1,4}/g, "<date>")
    // Times are only collapsed when preceded by whitespace or start of string
    // so we never accidentally match the "99:15" inside a "[99:158b]" tag.
    .replace(/(^|\s)\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\b/g, "$1<time>")
    .replace(/0x[0-9a-fA-F]+/g, "<hex>")
    .replace(/\b\d{4,}\b/g, "<num>")
    .replace(/"[^"]*"/g, '"<str>"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * When the regular log discovery returns zero files on a remote host, run a
 * lightweight diagnostic so the user can see WHY (dir missing, dir present
 * but empty, permission denied on stat, etc). Pure read-only `ls -1 + test`.
 * Returns one human-readable line per candidate root.
 */
async function diagnoseRemoteLogRoots(ctx: ExecutionContext): Promise<string[]> {
  if (ctx.kind === "local") return [];
  const roots = remoteLogRoots(ctx.os);
  if (roots.length === 0) return [];
  const out: string[] = [];
  if (ctx.os === "windows") {
    for (const r of roots) {
      try {
        const resolved = await ctx.runShell(`$ExecutionContext.InvokeCommand.ExpandString('${r.replace(/'/g, "''")}')`, { timeoutMs: 10000 });
        const path = resolved.stdout.trim();
        const exists = await ctx.pathExists(path);
        if (!exists) { out.push(`  ${path} (missing)`); continue; }
        const ls = await ctx.runShell(`(Get-ChildItem -LiteralPath '${path.replace(/'/g, "''")}' -File -ErrorAction SilentlyContinue | Measure-Object).Count`, { timeoutMs: 10000 });
        out.push(`  ${path} (exists, ${ls.stdout.trim() || "?"} file(s))`);
      } catch (e) {
        out.push(`  ${r} (diagnostic failed: ${(e as Error).message.slice(0, 80)})`);
      }
    }
    return out;
  }
  // POSIX: for each root, expand $HOME, test -e, list count + first few names.
  const dirsExpr = roots.map((r) => `"${r.replace(/"/g, '\\"')}"`).join(" ");
  const cmd =
    `for d in ${dirsExpr}; do ` +
    `  if [ ! -e "$d" ]; then echo "$d|missing"; ` +
    `  elif [ ! -r "$d" ]; then echo "$d|unreadable"; ` +
    `  else ` +
    `    n=$(/usr/bin/find "$d" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' '); ` +
    `    sample=$(/bin/ls -1 "$d" 2>/dev/null | head -3 | tr '\\n' ',' | sed 's/,$//'); ` +
    `    echo "$d|exists|files=$n|sample=$sample"; ` +
    `  fi; ` +
    `done`;
  try {
    const r = await ctx.runShell(cmd, { timeoutMs: 6000 });
    for (const line of (r.stdout || "").split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const [path, state, ...rest] = t.split("|");
      if (state === "missing") out.push(`  ${path} (missing)`);
      else if (state === "unreadable") out.push(`  ${path} (exists but unreadable — likely macOS TCC / Full Disk Access)`);
      else out.push(`  ${path} (${[state, ...rest].join(", ")})`);
    }
  } catch (e) {
    out.push(`  diagnostic failed: ${(e as Error).message.slice(0, 100)}`);
  }
  return out;
}

/**
 * macOS unified-log fallback for TeamViewer 15+.
 *
 * On modern macOS, TeamViewer no longer writes plain-text *.log files in
 * /Library/Logs/TeamViewer — its agents emit messages through Apple's unified
 * logging (os_log). We query the last 2h of system log entries whose process
 * name contains "TeamViewer" (or whose subsystem starts with com.teamviewer),
 * filter to error/warning-class lines, and return them so the same signature
 * clustering can be applied.
 *
 * The returned `text` is the same shape as `ctx.readFile()` output so callers
 * can pipe it through the existing scanner unchanged.
 */
async function harvestMacUnifiedLog(
  ctx: ExecutionContext
): Promise<{ text: string; lineCount: number } | null> {
  if (ctx.os !== "macos") return null;
  // `log show` is read-only and ships with macOS — no Full Disk Access needed.
  // --info gives us TeamViewer's TVLogging entries; without it we only get
  // default-level messages and lose most of the diagnostic content.
  // 24h window: TeamViewer drop incidents are sporadic — a 2h window catches
  // only steady-state activity and misses the actual failure burst the user
  // is calling about. egrep filters to lines that actually indicate a problem
  // (NetWatchdog disconnected, Connection timed out, Resolve failed,
  // handshake failed, KeepAlive timeout, etc).
  const cmd =
    `log show --predicate 'process CONTAINS "TeamViewer" OR subsystem CONTAINS[c] "teamviewer"' ` +
    `--info --last 24h --style compact 2>/dev/null | ` +
    `egrep -i 'error|warn|fail|drop|disconnect|timeout|reconnect|abort|reject|denied|unable|cannot|refused|handshake' | ` +
    `tail -800`;
  try {
    const r = await ctx.runShell(cmd, { timeoutMs: 30000 });
    const text = (r.stdout || "").trim();
    if (!text) return { text: "", lineCount: 0 };
    const lineCount = text.split(/\r?\n/).filter((l) => l.trim()).length;
    return { text, lineCount };
  } catch {
    return null;
  }
}

/** Line-class filter shared by the history (`log show`) and live (`log stream`) paths. */
const UNIFIED_LOG_FILTER =
  "error|warn|fail|drop|disconnect|timeout|reconnect|abort|reject|denied|" +
  "unable|cannot|refused|handshake|reset|retry|netwatchdog|resolve";

/**
 * Build the POSIX shell command that captures a LIVE macOS unified-log stream
 * for `windowSec` seconds. Pure + exported so the command shape is unit-testable
 * without a real macOS host.
 *
 * Design (reliability-first): the live `log stream` writes to a temp file for
 * the whole window, then we cleanly kill it, grep the COMPLETE file for
 * failure-class lines, and remove the temp file. This avoids relying on
 * partial-stdout-on-timeout or mid-pipe buffering — the command exits 0 with
 * the full filtered capture, so `ctx.runShell` returns deterministic output.
 */
export function buildMacCaptureCommand(windowSec: number): string {
  const secs = Math.max(1, Math.floor(windowSec));
  const predicate = `process CONTAINS "TeamViewer" OR subsystem CONTAINS[c] "teamviewer"`;
  return (
    `TWC_CAP=$(mktemp /tmp/twc_capture.XXXXXX); ` +
    `log stream --predicate '${predicate}' --info --style compact >"$TWC_CAP" 2>/dev/null & ` +
    `TWC_PID=$!; ` +
    `sleep ${secs}; ` +
    `kill "$TWC_PID" 2>/dev/null; ` +
    `wait "$TWC_PID" 2>/dev/null; ` +
    `egrep -i '${UNIFIED_LOG_FILTER}' "$TWC_CAP" 2>/dev/null | tail -800; ` +
    `rm -f "$TWC_CAP"`
  );
}

/**
 * macOS LIVE capture: stream the unified log for `windowSec` seconds and return
 * the failure-class lines that occurred DURING the window. Used by the
 * `--capture` mode so an intermittent disconnect can be diagnosed from the real
 * event rather than from stale history.
 */
async function captureMacUnifiedLog(
  ctx: ExecutionContext,
  windowSec: number
): Promise<{ text: string; lineCount: number } | null> {
  if (ctx.os !== "macos") return null;
  const cmd = buildMacCaptureCommand(windowSec);
  // Give the remote/local shell the full window + generous margin for SSH
  // round-trip, process spin-up and teardown.
  const timeoutMs = Math.max(1, Math.floor(windowSec)) * 1000 + 20000;
  try {
    const r = await ctx.runShell(cmd, { timeoutMs });
    const text = (r.stdout || "").trim();
    if (!text) return { text: "", lineCount: 0 };
    const lineCount = text.split(/\r?\n/).filter((l) => l.trim()).length;
    return { text, lineCount };
  } catch {
    return null;
  }
}

/**
 * Parse the combined `pmset -g` + NetWatchdog event block emitted by
 * harvestMacPowerEvents into a structured PowerEventSummary. Pure + exported so
 * it is unit-testable without a real macOS host.
 *
 * Expected input shape (two labelled sections):
 *   ===PMSET===
 *    standby              1
 *    powernap             0
 *    ...
 *   ===EVENTS===
 *   2026-06-08 15:53:27 ... NetWatchdog: Completely disconnected. Going offline
 *   2026-06-08 19:12:33 ... NetWatchdog: OnStandby woke up
 */
export function parseMacPowerEvents(raw: string): PowerEventSummary {
  let section: "pmset" | "events" | "" = "";
  const pmset: Record<string, string> = {};
  const eventLines: string[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (/^===\s*PMSET\s*===$/i.test(t)) { section = "pmset"; continue; }
    if (/^===\s*EVENTS\s*===$/i.test(t)) { section = "events"; continue; }
    if (section === "pmset") {
      const m = t.match(/^([a-z]+)\s+(-?\d+)\b/i);
      if (m) pmset[m[1].toLowerCase()] = m[2];
    } else if (section === "events" && t) {
      eventLines.push(t);
    }
  }

  let standbyDisconnects = 0;
  let standbyEnters = 0;
  let wakeRecoveries = 0;
  const disconnectTimes: string[] = [];
  for (const l of eventLines) {
    if (/completely disconnected|going offline/i.test(l)) {
      standbyDisconnects++;
      const tm = l.match(/\b(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (tm) disconnectTimes.push(tm[1]);
    }
    if (/onstandby going to sleep/i.test(l)) standbyEnters++;
    if (/onstandby woke up|internet is now connected/i.test(l)) wakeRecoveries++;
  }

  const num = (k: string): number | undefined => (k in pmset ? Number(pmset[k]) : undefined);
  const flag = (k: string, on: number): boolean | undefined => {
    const v = num(k);
    return v === undefined ? undefined : v === on;
  };
  const summaryKeys = ["sleep", "standby", "powernap", "tcpkeepalive", "standbydelaylow", "womp"];
  const pmsetSummary = summaryKeys.filter((k) => k in pmset).map((k) => `${k}=${pmset[k]}`).join(", ") || undefined;

  return {
    standbyDisconnects,
    standbyEnters,
    wakeRecoveries,
    disconnectTimes,
    os: "macos",
    sleepDisabled: flag("sleep", 0),
    standbyEnabled: flag("standby", 1),
    powerNapEnabled: flag("powernap", 1),
    tcpKeepAlive: flag("tcpkeepalive", 1),
    standbyDelayLowSec: num("standbydelaylow"),
    pmsetSummary
  };
}

/**
 * macOS power-management harvest: one read-only command that emits the current
 * `pmset -g` settings plus the last-24h TeamViewer NetWatchdog standby/wake
 * lines, so parseMacPowerEvents can correlate idle-sleep with disconnects.
 * Returns null on non-macOS or if the command fails.
 */
async function harvestMacPowerEvents(ctx: ExecutionContext): Promise<PowerEventSummary | null> {
  if (ctx.os !== "macos") return null;
  const cmd =
    `echo "===PMSET==="; pmset -g 2>/dev/null; ` +
    `echo "===EVENTS==="; ` +
    `log show --predicate 'process CONTAINS "TeamViewer"' --info --last 24h --style compact 2>/dev/null ` +
    `| egrep -i 'NetWatchdog|OnStandby|Going offline|woke up|Internet is now connected' | tail -200`;
  try {
    const r = await ctx.runShell(cmd, { timeoutMs: 30000 });
    const out = r.stdout || "";
    if (!out.trim()) return null;
    return parseMacPowerEvents(out);
  } catch {
    return null;
  }
}

/**
 * Parse the combined powercfg + Kernel-Power event block emitted by
 * harvestWindowsPowerEvents into a structured PowerEventSummary. Pure +
 * exported so it is unit-testable without a real Windows host.
 *
 * Expected input shape (two labelled sections):
 *   ===CONFIG===
 *   sleep_supported=1
 *   standby_timeout_ac_sec=1800
 *   standby_timeout_dc_sec=600
 *   ===EVENTS===
 *   2026-06-08 15:53:27 Id=42      (system entering sleep)
 *   2026-06-08 19:12:33 Id=107     (system resumed from sleep)
 *
 * Windows mapping vs macOS:
 *   • Kernel-Power Id 42 / 506  → system entered (modern) standby = a real drop
 *   • Kernel-Power Id 107 / 507 / 1 → resume from sleep = the reconnect on wake
 * Each idle-sleep drops the TeamViewer connection until the box wakes, exactly
 * like the macOS NetWatchdog standby pattern — so the post-wake RetryHandle
 * burst is reconnection aftermath, not the root cause.
 */
export function parseWindowsPowerEvents(raw: string): PowerEventSummary {
  let section: "config" | "events" | "" = "";
  const config: Record<string, string> = {};
  const eventLines: string[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (/^===\s*CONFIG\s*===$/i.test(t)) { section = "config"; continue; }
    if (/^===\s*EVENTS\s*===$/i.test(t)) { section = "events"; continue; }
    if (section === "config") {
      const m = t.match(/^([a-z_]+)\s*=\s*(-?\d+)$/i);
      if (m) config[m[1].toLowerCase()] = m[2];
    } else if (section === "events" && t) {
      eventLines.push(t);
    }
  }

  let standbyDisconnects = 0; // sleep-enter events (42 / 506)
  let wakeRecoveries = 0; // resume events (107 / 507 / 1)
  const disconnectTimes: string[] = [];
  for (const l of eventLines) {
    const idm = l.match(/\bId\s*=\s*(\d+)/i);
    if (!idm) continue;
    const id = Number(idm[1]);
    if (id === 42 || id === 506) {
      standbyDisconnects++;
      const tm = l.match(/\b(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (tm) disconnectTimes.push(tm[1]);
    } else if (id === 107 || id === 507 || id === 1) {
      wakeRecoveries++;
    }
  }

  const num = (k: string): number | undefined => (k in config ? Number(config[k]) : undefined);
  const acSec = num("standby_timeout_ac_sec");
  const dcSec = num("standby_timeout_dc_sec");
  const sleepSupported = num("sleep_supported");
  const parts: string[] = [];
  if (sleepSupported !== undefined) parts.push(`sleep ${sleepSupported === 1 ? "supported" : "unavailable"}`);
  if (acSec !== undefined) parts.push(`standby-timeout(AC)=${acSec}s${acSec === 0 ? " (never)" : ""}`);
  if (dcSec !== undefined) parts.push(`standby-timeout(DC)=${dcSec}s${dcSec === 0 ? " (never)" : ""}`);
  const powercfgSummary = parts.length ? parts.join(", ") : undefined;

  return {
    standbyDisconnects,
    standbyEnters: standbyDisconnects,
    wakeRecoveries,
    disconnectTimes,
    os: "windows",
    sleepDisabled: acSec === undefined ? undefined : acSec === 0,
    standbyEnabled: acSec === undefined ? undefined : acSec > 0,
    standbyDelayLowSec: acSec,
    powercfgSummary
  };
}

/**
 * Windows power-management harvest: one read-only PowerShell command that emits
 * the current sleep configuration (powercfg) plus the last-24h Kernel-Power
 * sleep/resume events, so parseWindowsPowerEvents can correlate idle-sleep with
 * the TeamViewer disconnect/reconnect bursts. Returns null on non-Windows or if
 * the command fails. All calls are read-only (no powercfg /setactive, no
 * /change) — it never alters the host's power plan.
 */
async function harvestWindowsPowerEvents(ctx: ExecutionContext): Promise<PowerEventSummary | null> {
  if (ctx.os !== "windows") return null;
  const cmd =
    `Write-Output '===CONFIG==='; ` +
    `$states = (powercfg /a 2>$null) -join ' '; ` +
    `if ($states -match 'Standby') { 'sleep_supported=1' } else { 'sleep_supported=0' }; ` +
    `$q = (powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null) -join ' '; ` +
    `$ac = [regex]::Match($q, 'Current AC Power Setting Index:\\s*0x([0-9A-Fa-f]+)'); ` +
    `if ($ac.Success) { 'standby_timeout_ac_sec=' + [Convert]::ToInt32($ac.Groups[1].Value,16) }; ` +
    `$dc = [regex]::Match($q, 'Current DC Power Setting Index:\\s*0x([0-9A-Fa-f]+)'); ` +
    `if ($dc.Success) { 'standby_timeout_dc_sec=' + [Convert]::ToInt32($dc.Groups[1].Value,16) }; ` +
    `Write-Output '===EVENTS==='; ` +
    `Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; StartTime=(Get-Date).AddHours(-24)} -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Id -in 42,107,506,507 } | Sort-Object TimeCreated | ` +
    `ForEach-Object { '{0:yyyy-MM-dd HH:mm:ss} Id={1}' -f $_.TimeCreated, $_.Id }`;
  try {
    const r = await ctx.runShell(cmd, { timeoutMs: 30000 });
    const out = r.stdout || "";
    if (!out.trim()) return null;
    return parseWindowsPowerEvents(out);
  } catch {
    return null;
  }
}

/**
 * Parse the systemd-logind / kernel suspend block emitted by
 * harvestLinuxPowerEvents into a structured PowerEventSummary. Pure + exported
 * so it is unit-testable without a real Linux host.
 *
 * Expected input shape (two labelled sections):
 *   ===CONFIG===
 *   suspend_masked=0
 *   ===EVENTS===
 *   2026-06-08T15:53:27 SUSPEND
 *   2026-06-08T19:12:33 RESUME
 *
 * Linux mapping vs macOS: a desktop/laptop entering systemd suspend drops the
 * TeamViewer connection exactly like macOS standby. Most Linux *servers* and
 * cloud VMs never suspend, so this is typically a clean "ruled out" no-op there.
 */
export function parseLinuxPowerEvents(raw: string): PowerEventSummary {
  let section: "config" | "events" | "" = "";
  const config: Record<string, string> = {};
  const eventLines: string[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (/^===\s*CONFIG\s*===$/i.test(t)) { section = "config"; continue; }
    if (/^===\s*EVENTS\s*===$/i.test(t)) { section = "events"; continue; }
    if (section === "config") {
      const m = t.match(/^([a-z_]+)\s*=\s*(-?\d+)$/i);
      if (m) config[m[1].toLowerCase()] = m[2];
    } else if (section === "events" && t) {
      eventLines.push(t);
    }
  }

  let standbyDisconnects = 0;
  let wakeRecoveries = 0;
  const disconnectTimes: string[] = [];
  for (const l of eventLines) {
    // harvestLinuxPowerEvents appends an uppercase SUSPEND/RESUME marker token
    // at end-of-line. Match that token (case-sensitive, anchored) so the
    // lowercase word "suspend" inside a "suspend exit RESUME" line never
    // double-counts as a suspend.
    const marker = l.match(/\b(SUSPEND|RESUME)\s*$/);
    if (!marker) continue;
    if (marker[1] === "SUSPEND") {
      standbyDisconnects++;
      const tm = l.match(/\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
      if (tm) disconnectTimes.push(tm[1].replace("T", " "));
    } else {
      wakeRecoveries++;
    }
  }

  const suspendMasked = "suspend_masked" in config ? Number(config["suspend_masked"]) : undefined;
  const parts: string[] = [];
  if (suspendMasked !== undefined) parts.push(`suspend ${suspendMasked === 1 ? "masked (disabled)" : "available"}`);
  const powercfgSummary = parts.length ? parts.join(", ") : undefined;

  return {
    standbyDisconnects,
    standbyEnters: standbyDisconnects,
    wakeRecoveries,
    disconnectTimes,
    os: "linux",
    sleepDisabled: suspendMasked === undefined ? undefined : suspendMasked === 1,
    standbyEnabled: suspendMasked === undefined ? undefined : suspendMasked === 0,
    powercfgSummary
  };
}

/**
 * Linux power-management harvest: read-only journalctl query for the last-24h
 * systemd-logind / kernel suspend & resume transitions, plus whether suspend is
 * masked. Returns null on non-Linux, when journalctl is unavailable (e.g. a
 * container with no systemd — the common Kubernetes case), or on failure.
 */
async function harvestLinuxPowerEvents(ctx: ExecutionContext): Promise<PowerEventSummary | null> {
  if (ctx.os !== "linux") return null;
  const cmd =
    `echo "===CONFIG==="; ` +
    `if command -v systemctl >/dev/null 2>&1; then ` +
    `m=$(systemctl is-enabled sleep.target suspend.target 2>/dev/null | grep -c masked); ` +
    `echo "suspend_masked=$([ "$m" -ge 1 ] && echo 1 || echo 0)"; fi; ` +
    `echo "===EVENTS==="; ` +
    `if command -v journalctl >/dev/null 2>&1; then ` +
    `journalctl --since "24 hours ago" -o short-iso --no-pager 2>/dev/null ` +
    `| egrep -i 'PrepareForSleep|System is suspending|suspend entry|System resumed|suspend exit' ` +
    `| sed -E 's/.*(suspend entry|System is suspending|PrepareForSleep.*start|PrepareForSleep.*b true).*/\\0 SUSPEND/; s/.*(suspend exit|System resumed|PrepareForSleep.*b false).*/\\0 RESUME/' ` +
    `| tail -200; fi`;
  try {
    const r = await ctx.runShell(cmd, { timeoutMs: 30000 });
    const out = r.stdout || "";
    if (!out.trim()) return null;
    return parseLinuxPowerEvents(out);
  } catch {
    return null;
  }
}

export async function runLogProbe(
  profile: ProductDiagnosticProfile = getProductProfile("teamviewer-remote"),
  ctx: ExecutionContext = new LocalContext(),
  captureWindowSec?: number
): Promise<LogProbeReport> {
  const diagnostics: string[] = [];

  // macOS power-management correlation (read-only). Gathered once up front so
  // EVERY return path (live capture, history, empty) carries the standby story.
  // On non-macOS targets this is a no-op (returns undefined).
  const power =
    ctx.os === "macos"
      ? ((await harvestMacPowerEvents(ctx)) ?? undefined)
      : ctx.os === "windows"
        ? ((await harvestWindowsPowerEvents(ctx)) ?? undefined)
        : ctx.os === "linux"
          ? ((await harvestLinuxPowerEvents(ctx)) ?? undefined)
          : undefined;

  // LIVE CAPTURE MODE (macOS only, opt-in via --capture <minutes>).
  // For intermittent "drops every few minutes" symptoms the last-24h history
  // often misses the actual failure burst (it's full of steady-state license
  // checks). Instead, stream the unified log for the requested window so the
  // diagnosis runs on the REAL disconnect event captured live. If nothing
  // error-class shows up in the window, fall through to the normal history.
  if (captureWindowSec && captureWindowSec > 0) {
    if (ctx.os === "macos") {
      const cap = await captureMacUnifiedLog(ctx, captureWindowSec);
      if (cap && cap.lineCount > 0) {
        const scan = scanText(cap.text);
        diagnostics.push(
          `Live-captured ${cap.lineCount} TeamViewer unified-log entries over a ${captureWindowSec}s window ` +
            `(${scan.errorCount} error(s), ${scan.warningCount} warning(s)). Diagnosis runs on this live capture.`
        );
        return {
          filesInspected: [`<macOS unified log (live capture, ${captureWindowSec}s): log stream --predicate process CONTAINS TeamViewer>`],
          totalLines: scan.totalLines,
          errorCount: scan.errorCount,
          warningCount: scan.warningCount,
          topSignatures: scan.topSignatures,
          diagnostics,
          product: profile.name,
          executionTarget: ctx.description,
          power
        };
      }
      diagnostics.push(
        `Live capture window (${captureWindowSec}s) elapsed with no error/warning-class TeamViewer entries — ` +
          `the symptom did not reproduce during the window. Falling back to recent log history.`
      );
    } else {
      diagnostics.push(
        `Live capture (--capture) is currently supported on macOS targets only; this target is ${ctx.os}. ` +
          `Falling back to recent log history.`
      );
    }
  }

  const files = ctx.kind === "local"
    ? await findLogFilesLocal(profile, ctx)
    : await findLogFilesRemote(profile, ctx);

  if (files.length === 0) {
    diagnostics.push(`No ${profile.name} log files found in standard locations.`);
    // Surface WHY — dir missing, present-but-empty, unreadable, etc.
    if (ctx.kind !== "local") {
      const details = await diagnoseRemoteLogRoots(ctx);
      if (details.length > 0) {
        diagnostics.push(`Candidate log directories on ${ctx.description}:`);
        diagnostics.push(...details);
      }
    }
    // macOS-specific fallback: TeamViewer 15+ emits via Apple unified logging,
    // not plain log files. Query `log show` and run the same clustering on it.
    if (ctx.os === "macos") {
      const unified = await harvestMacUnifiedLog(ctx);
      if (unified && unified.lineCount > 0) {
        diagnostics.push(
          `Found ${unified.lineCount} TeamViewer entries in the macOS unified log (last 24h, filtered to error/warn/fail/drop/disconnect/timeout/handshake patterns).`
        );
        const scan = scanText(unified.text);
        if (scan.errorCount + scan.warningCount === 0 && scan.totalLines > 0) {
          diagnostics.push(
            `Scanned ${scan.totalLines} unified-log lines; no error/warning-class entries (only steady-state activity).`
          );
        } else if (scan.errorCount + scan.warningCount > 0) {
          diagnostics.push(
            `Scanned ${scan.totalLines} unified-log lines; ${scan.errorCount} error(s), ${scan.warningCount} warning(s).`
          );
        }
        return {
          filesInspected: ["<macOS unified log: log show --predicate process CONTAINS TeamViewer>"],
          totalLines: scan.totalLines,
          errorCount: scan.errorCount,
          warningCount: scan.warningCount,
          topSignatures: scan.topSignatures,
          diagnostics,
          product: profile.name,
          executionTarget: ctx.description,
          power
        };
      }
      if (unified) {
        diagnostics.push(
          "macOS unified log queried (last 24h, TeamViewer process filter): zero entries returned. The TeamViewer service may not have logged anything recently or os_log retention has aged out the entries."
        );
      } else {
        diagnostics.push(
          "macOS unified-log fallback failed (log show command errored or timed out)."
        );
      }
    }
    return {
      filesInspected: [],
      totalLines: 0,
      errorCount: 0,
      warningCount: 0,
      topSignatures: [],
      diagnostics,
      product: profile.name,
      executionTarget: ctx.description,
      power
    };
  }

  const counts = new Map<string, { count: number; example: string }>();
  let totalLines = 0;
  let errorCount = 0;
  let warningCount = 0;

  for (const file of files) {
    const text = await ctx.readFile(file.path, MAX_BYTES_PER_FILE);
    if (!text) continue;
    const scan = scanText(text, counts);
    totalLines += scan.totalLines;
    errorCount += scan.errorCount;
    warningCount += scan.warningCount;
  }

  const topSignatures: SignatureCluster[] = rankSignatures(counts);

  if (errorCount === 0 && warningCount === 0) {
    diagnostics.push(`Scanned ${totalLines} lines across ${files.length} file(s); no errors or warnings detected.`);
  } else {
    diagnostics.push(`Scanned ${totalLines} lines; ${errorCount} error(s), ${warningCount} warning(s).`);
  }

  return {
    filesInspected: files.map((f) => f.path),
    totalLines,
    errorCount,
    warningCount,
    topSignatures,
    diagnostics,
    product: profile.name,
    executionTarget: ctx.description,
    power
  };
}

// Re-export for any external consumer that imports `path` from this module
// (kept to mirror the old signature; safe to drop in a future cleanup).
export const _internalPath = path;

/**
 * Shared scanner used by both the file path and the macOS unified-log path.
 * Mutates the optional `counts` map in place so callers can accumulate across
 * multiple inputs; returns lightweight aggregate counts + (when no map was
 * passed) a freshly-built topSignatures list.
 */
function scanText(
  text: string,
  counts: Map<string, { count: number; example: string }> = new Map()
): { totalLines: number; errorCount: number; warningCount: number; topSignatures: SignatureCluster[] } {
  let totalLines = 0;
  let errorCount = 0;
  let warningCount = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    totalLines++;
    const isErr = /\b(error|err|fatal|fail(?:ed|ure)?|exception|refused|denied|abort)\b/i.test(line);
    const isWarn = /\b(warn|warning|drop|disconnect|timeout|reconnect|unable|cannot)\b/i.test(line);
    if (!isErr && !isWarn) continue;
    if (isErr) errorCount++;
    if (isWarn) warningCount++;
    const sig = normalize(line).slice(0, 200);
    const existing = counts.get(sig);
    if (existing) existing.count++;
    else counts.set(sig, { count: 1, example: line.slice(0, 240) });
  }
  const topSignatures: SignatureCluster[] = rankSignatures(counts);
  return { totalLines, errorCount, warningCount, topSignatures };
}
