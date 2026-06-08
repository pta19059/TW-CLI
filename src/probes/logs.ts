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
      "/Library/Logs/TeamViewer"
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
    // Most TeamViewer installs log under %APPDATA%\TeamViewer. ProgramData
    // covers ServiceMode and DEX. PowerShell-friendly expansion.
    return [
      "$env:APPDATA\\TeamViewer",
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
    // Note: backtick-t is PowerShell's tab escape. Inside this JS template literal
    // we escape the backtick (\`) so it becomes a literal backtick in the command.
    const escaped = patternSrc.replace(/'/g, "''");
    const dirsExpr = roots.map((r) => `'${r.replace(/'/g, "''")}'`).join(",");
    const cmd =
      `$pat='${escaped}'; ` +
      `foreach($d in @(${dirsExpr})){ ` +
      `  $resolved = $ExecutionContext.InvokeCommand.ExpandString($d); ` +
      `  if(Test-Path $resolved){ Get-ChildItem -LiteralPath $resolved -File -ErrorAction SilentlyContinue | ` +
      `    Where-Object { $_.Name -match $pat } | ForEach-Object { '{0}\`t{1}' -f $_.Length, $_.FullName } } ` +
      `}`;
    const r = await ctx.runShell(cmd, { timeoutMs: 8000 });
    return parseSizePathPairs(r.stdout).slice(0, MAX_FILES);
  }

  // POSIX (linux + macos): expand $HOME-style paths and stat each match.
  // The remote regex filter uses `awk` since `find` doesn't natively grok JS-style regex.
  const dirsExpr = roots.map((r) => `"${r.replace(/"/g, '\\"')}"`).join(" ");
  // Convert the JS regex (which often uses \. and (?:...)) into something ERE-compatible
  // enough for `awk`. We keep it simple: escape sequences pass through.
  const awkPat = patternSrc.replace(/'/g, "'\\''");
  const cmd =
    `for d in ${dirsExpr}; do ` +
    `  if [ -d "$d" ]; then ` +
    `    /usr/bin/find "$d" -maxdepth 1 -type f 2>/dev/null | ` +
    `    awk -v pat='${awkPat}' 'match($0, "[^/]+$"){ name=substr($0,RSTART,RLENGTH); if (name ~ pat) print $0 }' | ` +
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
export function normalize(line: string): string {
  return line
    .replace(/\d{2,4}[-\/]\d{1,2}[-\/]\d{1,4}/g, "<date>")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?/g, "<time>")
    .replace(/0x[0-9a-fA-F]+/g, "<hex>")
    .replace(/\b\d{4,}\b/g, "<num>")
    .replace(/"[^"]*"/g, '"<str>"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function runLogProbe(
  profile: ProductDiagnosticProfile = getProductProfile("teamviewer-remote"),
  ctx: ExecutionContext = new LocalContext()
): Promise<LogProbeReport> {
  const diagnostics: string[] = [];
  const files = ctx.kind === "local"
    ? await findLogFilesLocal(profile, ctx)
    : await findLogFilesRemote(profile, ctx);

  if (files.length === 0) {
    diagnostics.push(`No ${profile.name} log files found in standard locations.`);
    return {
      filesInspected: [],
      totalLines: 0,
      errorCount: 0,
      warningCount: 0,
      topSignatures: [],
      diagnostics,
      product: profile.name,
      executionTarget: ctx.description
    };
  }

  const counts = new Map<string, { count: number; example: string }>();
  let totalLines = 0;
  let errorCount = 0;
  let warningCount = 0;

  for (const file of files) {
    const text = await ctx.readFile(file.path, MAX_BYTES_PER_FILE);
    if (!text) continue;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      totalLines++;
      const isErr = /\b(error|err|fatal|fail(?:ed|ure)?|exception)\b/i.test(line);
      const isWarn = /\b(warn|warning)\b/i.test(line);
      if (!isErr && !isWarn) continue;
      if (isErr) errorCount++;
      if (isWarn) warningCount++;
      const sig = normalize(line).slice(0, 200);
      const existing = counts.get(sig);
      if (existing) existing.count++;
      else counts.set(sig, { count: 1, example: line.slice(0, 240) });
    }
  }

  const topSignatures: SignatureCluster[] = [...counts.entries()]
    .map(([signature, { count, example }]) => ({ signature, count, exampleLine: example }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_SIGNATURES);

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
    executionTarget: ctx.description
  };
}

// Re-export for any external consumer that imports `path` from this module
// (kept to mirror the old signature; safe to drop in a future cleanup).
export const _internalPath = path;
