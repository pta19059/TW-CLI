// Real TeamViewer log harvester + signature clustering.
// Reads up to MAX_BYTES of each known log file and groups error/warning
// lines by a normalized signature (timestamps and numeric IDs stripped).
// Log directories and file-name pattern are driven by the per-product profile.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getProductProfile, productLogDirs, type ProductDiagnosticProfile } from "../catalog/productProfiles.js";

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
}

function candidateDirs(profile: ProductDiagnosticProfile): string[] {
  return productLogDirs(profile.key, process.platform).filter(existsSync);
}

function findLogFiles(profile: ProductDiagnosticProfile): string[] {
  const out: string[] = [];
  for (const dir of candidateDirs(profile)) {
    try {
      for (const name of readdirSync(dir)) {
        if (profile.logFilePattern.test(name)) {
          out.push(path.join(dir, name));
          if (out.length >= MAX_FILES) return out;
        }
      }
    } catch {
      /* dir unreadable, skip */
    }
  }
  return out;
}

function readTail(file: string): string {
  try {
    const stat = statSync(file);
    const size = stat.size;
    if (size <= MAX_BYTES_PER_FILE) {
      return readFileSync(file, "utf-8");
    }
    // Read the last MAX_BYTES_PER_FILE bytes by streaming a partial buffer.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(MAX_BYTES_PER_FILE);
      fs.readSync(fd, buf, 0, MAX_BYTES_PER_FILE, size - MAX_BYTES_PER_FILE);
      return buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
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

export function runLogProbe(
  profile: ProductDiagnosticProfile = getProductProfile("teamviewer-remote")
): LogProbeReport {
  const files = findLogFiles(profile);
  const diagnostics: string[] = [];
  if (files.length === 0) {
    diagnostics.push(`No ${profile.name} log files found in standard locations.`);
    return { filesInspected: [], totalLines: 0, errorCount: 0, warningCount: 0, topSignatures: [], diagnostics, product: profile.name };
  }

  const counts = new Map<string, { count: number; example: string }>();
  let totalLines = 0;
  let errorCount = 0;
  let warningCount = 0;

  for (const file of files) {
    const text = readTail(file);
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

  return { filesInspected: files, totalLines, errorCount, warningCount, topSignatures, diagnostics, product: profile.name };
}
