// Cross-platform "kill process tree" helper. On Windows `process.kill` only
// terminates the immediate node process and leaves spawned children orphaned;
// `taskkill /T /F` kills the whole tree.

import { spawnSync } from "node:child_process";

export function killProcessTree(pid: number): { ok: boolean; error?: string } {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { ok: false, error: "invalid pid" };
  }
  try {
    if (process.platform === "win32") {
      const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      if (res.status === 0) return { ok: true };
      // Fallback to plain kill so we at least signal the root process.
      try { process.kill(pid); } catch { /* noop */ }
      return { ok: false, error: `taskkill exited with code ${res.status}` };
    }
    process.kill(-pid, "SIGTERM");
    return { ok: true };
  } catch (err) {
    try { process.kill(pid); return { ok: true }; } catch { /* noop */ }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
