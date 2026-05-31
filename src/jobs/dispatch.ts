import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDataDir, jobLogPath } from "../paths.js";
import { updateJob } from "./jobStore.js";

/**
 * Resolve the compiled worker entrypoint relative to THIS module, not to
 * `process.cwd()`. The CLI is normally invoked from an arbitrary directory
 * (and via a global `npm link`), so a cwd-relative path would point at a
 * non-existent `dist/worker.js` and leave jobs stuck in `queued` forever.
 *
 * Layout: this file compiles to `dist/jobs/dispatch.js`; the worker compiles
 * to `dist/worker.js`, i.e. one directory up.
 */
function resolveWorkerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "worker.js");
}

export function startDetachedWorker(jobId: string): void {
  const processWithPkg = process as NodeJS.Process & { pkg?: unknown };
  const isPackaged = typeof processWithPkg.pkg !== "undefined";

  const args = isPackaged
    ? ["--worker", "--job-id", jobId]
    : [resolveWorkerPath(), "--job-id", jobId];

  ensureDataDir();
  const logFile = jobLogPath(jobId);
  // Truncate on each run; append would mix retried runs
  const outFd = openSync(logFile, "w");
  const errFd = openSync(logFile, "a");

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", outFd, errFd],
    env: { ...process.env, TWC_JOB_ID: jobId }
  });

  if (typeof child.pid === "number") {
    try {
      updateJob(jobId, { pid: child.pid });
    } catch {
      // job may not yet exist at the moment of update on extremely fast races; ignore
    }
  }

  child.unref();
}
