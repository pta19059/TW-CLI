import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * App data directory.
 *
 * Resolution is intentionally **cwd-independent** so the CLI reads and writes
 * the same store no matter which directory it is launched from (critical once
 * installed globally and used on a server/VM):
 *
 *   1. `TWC_HOME` env var (explicit override, useful for portable installs and tests)
 *   2. `./.twc-data` ONLY when it already exists AND no `~/.twc` store exists yet
 *      (one-time migration grace for legacy in-repo dev state)
 *   3. `~/.twc` (stable per-user location — the production default)
 */
function resolveAppDir(): string {
  if (process.env.TWC_HOME) {
    return path.resolve(process.env.TWC_HOME);
  }
  const userDir = path.join(os.homedir(), ".twc");
  if (existsSync(userDir)) return userDir;
  const legacy = path.resolve(process.cwd(), ".twc-data");
  if (existsSync(legacy)) return legacy;
  return userDir;
}

export const APP_DIR = resolveAppDir();
export const JOBS_FILE = path.join(APP_DIR, "jobs.json");
export const LOGS_DIR = path.join(APP_DIR, "logs");
export const HISTORY_FILE = path.join(APP_DIR, "history");
export const CONFIG_FILE = path.join(APP_DIR, "config.json");

export function ensureDataDir(): void {
  mkdirSync(APP_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
}

export function jobLogPath(jobId: string): string {
  return path.join(LOGS_DIR, `${jobId}.log`);
}
